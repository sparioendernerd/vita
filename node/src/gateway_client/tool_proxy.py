import logging
from typing import Any
from .ws_client import GatewayClient

logger = logging.getLogger(__name__)


class ToolProxy:
    """Proxies Gemini Live tool calls to the gateway for execution."""

    def __init__(self, gateway_client: GatewayClient):
        self.gateway = gateway_client

    async def execute(self, tool_name: str, args: dict[str, Any]) -> dict:
        logger.info(f"Proxying tool call: {tool_name}({args})")
        result = await self.gateway.call_tool(tool_name, args)
        logger.info(f"Tool result for {tool_name}: {result}")
        return result
