from __future__ import annotations

import datetime
from typing import Any, Callable, Optional


async def execute_local_tool(
    tool_name: str,
    args: dict[str, Any],
    *,
    on_enable_vision: Optional[Callable[[], None]] = None,
    on_disable_vision: Optional[Callable[[], None]] = None,
    on_enable_screenshare: Optional[Callable[[], None]] = None,
) -> dict[str, Any]:
    if tool_name == "get_current_time":
        now = datetime.datetime.now().astimezone()
        return {
            "time": now.strftime("%I:%M %p"),
            "date": now.strftime("%A, %B %d, %Y"),
            "timezone": str(now.tzinfo),
        }

    if tool_name == "enable_vision":
        if not on_enable_vision:
            return {"error": "Vision is unavailable without an active node session."}
        on_enable_vision()
        return {"result": "Vision enabled. I can see you now!"}

    if tool_name == "disable_vision":
        if not on_disable_vision:
            return {"error": "Vision is unavailable without an active node session."}
        on_disable_vision()
        return {"result": "Vision disabled. My eyes are closed."}

    if tool_name == "enable_screenshare":
        if not on_enable_screenshare:
            return {"error": "Screenshare is unavailable without an active node session."}
        on_enable_screenshare()
        return {"result": "Screenshare enabled. Checking your monitor now!"}

    if tool_name == "media_play_pause":
        from ..tools.media import media_play_pause

        return media_play_pause()

    if tool_name == "media_next_track":
        from ..tools.media import media_next_track

        return media_next_track()

    if tool_name == "media_prev_track":
        from ..tools.media import media_prev_track

        return media_prev_track()

    if tool_name == "media_volume_up":
        from ..tools.media import media_volume_up

        return media_volume_up()

    if tool_name == "media_volume_down":
        from ..tools.media import media_volume_down

        return media_volume_down()

    if tool_name == "list_steam_games":
        from ..tools.steam import list_steam_games

        return list_steam_games()

    if tool_name == "launch_steam_game":
        from ..tools.steam import launch_steam_game

        app_id = args.get("app_id")
        if not app_id:
            return {"error": "Missing app_id"}
        return launch_steam_game(str(app_id))

    return {"error": f"Unsupported local tool: {tool_name}"}
