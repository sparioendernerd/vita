import logging
from typing import Any, Callable, Optional
from google.genai import types
from ..gateway_client.tool_proxy import ToolProxy

logger = logging.getLogger(__name__)


class ToolHandler:
    """Handles Gemini Live tool calls by proxying them through the gateway."""

    def __init__(
        self,
        tool_proxy: ToolProxy,
        session: Any,
        on_end_session: Optional[Callable[[], None]] = None,
        on_enable_vision: Optional[Callable[[], None]] = None,
        on_disable_vision: Optional[Callable[[], None]] = None,
    ):
        self.proxy = tool_proxy
        self.session = session
        self.on_end_session = on_end_session
        self.on_enable_vision = on_enable_vision
        self.on_disable_vision = on_disable_vision

    async def handle_tool_call(self, tool_call: Any) -> None:
        """Process a tool_call from Gemini Live and send back the response."""
        responses = []

        for fc in tool_call.function_calls:
            logger.info(f"Tool call: {fc.name}({fc.args})")
            if fc.name == "get_current_time":
                import datetime
                now = datetime.datetime.now().astimezone()
                time_str = now.strftime("%I:%M %p")
                date_str = now.strftime("%A, %B %d, %Y")
                responses.append(
                    types.FunctionResponse(
                        id=fc.id,
                        name=fc.name,
                        response={"time": time_str, "date": date_str, "timezone": str(now.tzinfo)},
                    )
                )
                continue
            
            if fc.name == "deactivate_agent":
                responses.append(
                    types.FunctionResponse(
                        id=fc.id,
                        name=fc.name,
                        response={"result": "Agent successfully deactivated. You may say a final goodbye now."},
                    )
                )
                if self.on_end_session:
                    self.on_end_session()
                continue
            
            if fc.name == "enable_vision":
                responses.append(
                    types.FunctionResponse(
                        id=fc.id,
                        name=fc.name,
                        response={"result": "Vision enabled. I can see you now!"},
                    )
                )
                if self.on_enable_vision:
                    self.on_enable_vision()
                continue

            if fc.name == "disable_vision":
                responses.append(
                    types.FunctionResponse(
                        id=fc.id,
                        name=fc.name,
                        response={"result": "Vision disabled. My eye is closed."},
                    )
                )
                if self.on_disable_vision:
                    self.on_disable_vision()
                continue
                
            try:
                result = await self.proxy.execute(fc.name, dict(fc.args) if fc.args else {})
                responses.append(
                    types.FunctionResponse(
                        id=fc.id,
                        name=fc.name,
                        response=result,
                    )
                )
            except Exception as e:
                logger.error(f"Tool call failed: {fc.name}: {e}")
                responses.append(
                    types.FunctionResponse(
                        id=fc.id,
                        name=fc.name,
                        response={"error": str(e)},
                    )
                )

        if responses:
            await self.session.send_tool_response(function_responses=responses)
            logger.info(f"Sent {len(responses)} tool response(s)")
