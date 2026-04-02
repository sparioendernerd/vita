import asyncio
import json
import logging
from typing import Any, Callable, Coroutine
from uuid import uuid4
import websockets
from .protocol import create_message

logger = logging.getLogger(__name__)


class GatewayClient:
    """WebSocket client that connects to the VITA gateway."""

    def __init__(self, gateway_url: str, node_id: str, vita_name: str, gateway_token: str = ""):
        self.url = gateway_url
        self.node_id = node_id
        self.vita_name = vita_name
        self.gateway_token = gateway_token
        self._ws: websockets.WebSocketClientProtocol | None = None
        self._pending: dict[str, asyncio.Future] = {}
        self._command_handler: Callable[[str, dict], Coroutine] | None = None
        self._receive_task: asyncio.Task | None = None

    async def connect(self) -> None:
        logger.info(f"Connecting to gateway at {self.url}...")

        # If token is available, pass it as query param for HTTP-level auth
        url = self.url
        if self.gateway_token:
            separator = "&" if "?" in url else "?"
            url = f"{url}{separator}token={self.gateway_token}"

        self._ws = await websockets.connect(url)
        logger.info("Connected to gateway")

        if self.gateway_token:
            # Use new auth:handshake flow
            await self._send(create_message("auth:handshake", {
                "token": self.gateway_token,
                "nodeId": self.node_id,
                "vitaName": self.vita_name,
                "capabilities": ["audio", "tools"],
            }))

            # Wait for auth:result
            try:
                result = await self._wait_for_type_raw("auth:result", timeout=10.0)
                if not result.get("success"):
                    error = result.get("error", "Unknown auth error")
                    logger.error(f"Authentication failed: {error}")
                    await self._ws.close()
                    raise RuntimeError(f"Gateway auth failed: {error}")

                if result.get("pairingRequired"):
                    code = result.get("pairingCode", "???")
                    logger.warning(f"━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
                    logger.warning(f"  NODE PAIRING REQUIRED")
                    logger.warning(f"  Code: {code}")
                    logger.warning(f"  Run on gateway: npm run pairing approve {code}")
                    logger.warning(f"━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
                    # Stay connected, waiting for approval
                    # On next reconnect after approval, it should work
                else:
                    logger.info(f"Authenticated and registered as node {self.node_id}")
            except asyncio.TimeoutError:
                logger.error("Auth handshake timed out")
                await self._ws.close()
                raise RuntimeError("Gateway auth handshake timed out")
        else:
            # Legacy mode: no token, use old node:register
            await self._send(create_message("node:register", {
                "nodeId": self.node_id,
                "vitaName": self.vita_name,
                "capabilities": ["audio", "tools"],
            }))
            logger.info(f"Registered as node {self.node_id} for VITA {self.vita_name} (legacy mode)")

        # Start receive loop
        self._receive_task = asyncio.create_task(self._receive_loop())

    async def disconnect(self) -> None:
        if self._receive_task:
            self._receive_task.cancel()
            self._receive_task = None
        if self._ws:
            await self._ws.close()
            self._ws = None

    def on_command(self, handler: Callable[[str, dict], Coroutine]) -> None:
        self._command_handler = handler

    async def request_session_config(self) -> dict:
        """Request VITA config and memories for starting a Live session."""
        await self._send(create_message("session:start", {
            "vitaName": self.vita_name,
        }))
        return await self._wait_for_type("session:config")

    async def notify_session_end(self, reason: str) -> None:
        await self._send(create_message("session:end", {
            "vitaName": self.vita_name,
            "reason": reason,
        }))

    async def call_tool(self, tool_name: str, args: dict[str, Any]) -> dict:
        """Send a tool call to the gateway and wait for the response."""
        call_id = str(uuid4())
        future = asyncio.get_event_loop().create_future()
        self._pending[call_id] = future

        await self._send(create_message("tool:request", {
            "callId": call_id,
            "toolName": tool_name,
            "args": args,
        }))

        return await future

    async def send_transcript(self, role: str, text: str) -> None:
        await self._send(create_message("transcript:entry", {
            "vitaName": self.vita_name,
            "role": role,
            "text": text,
        }))

    async def send_status(self, state: str) -> None:
        await self._send(create_message("node:status", {
            "nodeId": self.node_id,
            "state": state,
        }))

    async def send_command_result(self, call_id: str, result: dict | None = None, error: str | None = None) -> None:
        await self._send(create_message("node:command:result", {
            "callId": call_id,
            "result": result,
            "error": error,
        }))

    async def _send(self, msg: dict) -> None:
        if self._ws:
            await self._ws.send(json.dumps(msg))

    async def _receive_loop(self) -> None:
        if not self._ws:
            return
        try:
            async for raw in self._ws:
                try:
                    msg = json.loads(raw)
                    await self._dispatch(msg)
                except json.JSONDecodeError:
                    logger.error(f"Invalid JSON from gateway: {raw[:100]}")
        except websockets.ConnectionClosed:
            logger.warning("Gateway connection closed")

    async def _dispatch(self, msg: dict) -> None:
        msg_type = msg.get("type", "")
        payload = msg.get("payload", {})

        if msg_type == "gateway:ping":
            await self._send(create_message("node:heartbeat", {
                "nodeId": self.node_id,
                "timestamp": msg["payload"].get("timestamp"),
            }))

        elif msg_type == "tool:response":
            call_id = payload.get("callId")
            future = self._pending.pop(call_id, None)
            if future and not future.done():
                if "error" in payload:
                    future.set_exception(RuntimeError(payload["error"]))
                else:
                    future.set_result(payload.get("result", {}))

        elif msg_type == "session:config":
            # Handled by _wait_for_type
            pass

        elif msg_type == "gateway:command":
            if self._command_handler:
                await self._command_handler(payload.get("command", ""), payload.get("args", {}))

        else:
            logger.debug(f"Unhandled message type: {msg_type}")

    async def _wait_for_type(self, msg_type: str, timeout: float = 10.0) -> dict:
        """Wait for a specific message type from the gateway."""
        if not self._ws:
            raise RuntimeError("Not connected")

        # Temporarily intercept messages in the receive loop
        future: asyncio.Future[dict] = asyncio.get_event_loop().create_future()

        original_dispatch = self._dispatch

        async def intercepting_dispatch(msg: dict) -> None:
            if msg.get("type") == msg_type and not future.done():
                future.set_result(msg.get("payload", {}))
            else:
                await original_dispatch(msg)

        self._dispatch = intercepting_dispatch  # type: ignore
        try:
            return await asyncio.wait_for(future, timeout)
        finally:
            self._dispatch = original_dispatch  # type: ignore

    async def _wait_for_type_raw(self, msg_type: str, timeout: float = 10.0) -> dict:
        """Wait for a specific message type by reading directly from the WebSocket.
        Used before the receive loop is started (e.g. during auth handshake)."""
        if not self._ws:
            raise RuntimeError("Not connected")

        async def _read():
            async for raw in self._ws:
                msg = json.loads(raw)
                if msg.get("type") == msg_type:
                    return msg.get("payload", {})
            return {}

        return await asyncio.wait_for(_read(), timeout)
