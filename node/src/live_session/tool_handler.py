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
        on_enable_screenshare: Optional[Callable[[], None]] = None,
    ):
        self.proxy = tool_proxy
        self.session = session
        self.on_end_session = on_end_session
        self.on_enable_vision = on_enable_vision
        self.on_disable_vision = on_disable_vision
        self.on_enable_screenshare = on_enable_screenshare

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
                        response={"result": "Vision disabled. My eyes are closed."},
                    )
                )
                if self.on_disable_vision:
                    self.on_disable_vision()
                continue
            
            if fc.name == "enable_screenshare":
                responses.append(
                    types.FunctionResponse(
                        id=fc.id,
                        name=fc.name,
                        response={"result": "Screenshare enabled. Checking your monitor now!"},
                    )
                )
                if self.on_enable_screenshare:
                    self.on_enable_screenshare()
                continue
            
            # --- Local Node Tools ---
            
            if fc.name == "media_play_pause":
                from ..tools.media import media_play_pause
                responses.append(types.FunctionResponse(id=fc.id, name=fc.name, response=media_play_pause()))
                continue

            if fc.name == "media_next_track":
                from ..tools.media import media_next_track
                responses.append(types.FunctionResponse(id=fc.id, name=fc.name, response=media_next_track()))
                continue

            if fc.name == "media_prev_track":
                from ..tools.media import media_prev_track
                responses.append(types.FunctionResponse(id=fc.id, name=fc.name, response=media_prev_track()))
                continue

            if fc.name == "media_volume_up":
                from ..tools.media import media_volume_up
                responses.append(types.FunctionResponse(id=fc.id, name=fc.name, response=media_volume_up()))
                continue

            if fc.name == "media_volume_down":
                from ..tools.media import media_volume_down
                responses.append(types.FunctionResponse(id=fc.id, name=fc.name, response=media_volume_down()))
                continue

            if fc.name == "list_steam_games":
                from ..tools.steam import list_steam_games
                responses.append(types.FunctionResponse(id=fc.id, name=fc.name, response=list_steam_games()))
                continue

            if fc.name == "launch_steam_game":
                from ..tools.steam import launch_steam_game
                app_id = fc.args.get("app_id")
                if not app_id:
                    responses.append(types.FunctionResponse(id=fc.id, name=fc.name, response={"error": "Missing app_id"}))
                else:
                    responses.append(types.FunctionResponse(id=fc.id, name=fc.name, response=launch_steam_game(app_id)))
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
