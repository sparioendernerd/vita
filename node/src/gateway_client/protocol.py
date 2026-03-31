from datetime import datetime, timezone
from typing import Any


def create_message(msg_type: str, payload: dict[str, Any]) -> dict:
    return {
        "type": msg_type,
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "payload": payload,
    }
