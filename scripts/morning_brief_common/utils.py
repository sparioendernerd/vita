from __future__ import annotations

import json
import os
import re
from dataclasses import asdict, is_dataclass
from datetime import datetime
from hashlib import sha1
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError


def now_in_timezone(timezone: str) -> datetime:
    try:
        return datetime.now(ZoneInfo(timezone))
    except ZoneInfoNotFoundError:
        return datetime.now().astimezone()


def ensure_dir(path: Path) -> Path:
    path.mkdir(parents=True, exist_ok=True)
    return path


def read_json(path: Path, default: Any) -> Any:
    if not path.exists():
        return default
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def write_json(path: Path, payload: Any) -> None:
    ensure_dir(path.parent)
    with path.open("w", encoding="utf-8") as handle:
        json.dump(_json_ready(payload), handle, indent=2, ensure_ascii=False)
        handle.write("\n")


def append_jsonl(path: Path, payload: Any) -> None:
    ensure_dir(path.parent)
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(_json_ready(payload), ensure_ascii=False) + "\n")


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    rows: list[dict[str, Any]] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        try:
            value = json.loads(stripped)
        except json.JSONDecodeError:
            continue
        if isinstance(value, dict):
            rows.append(value)
    return rows


def write_text(path: Path, value: str) -> None:
    ensure_dir(path.parent)
    path.write_text(value, encoding="utf-8")


def read_text(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        return path.read_text(encoding="utf-8", errors="ignore")


def stable_hash(*parts: str) -> str:
    joined = "||".join(part.strip().lower() for part in parts if part is not None)
    return sha1(joined.encode("utf-8")).hexdigest()


def normalize_whitespace(value: str) -> str:
    return re.sub(r"\s+", " ", value.strip())


def shell_quote(value: str) -> str:
    escaped = value.replace("\\", "\\\\").replace("\"", "\\\"")
    return f"\"{escaped}\""


def resolve_env_path(value: str) -> str:
    return os.path.expandvars(os.path.expanduser(value))


def _json_ready(payload: Any) -> Any:
    if is_dataclass(payload):
        return {key: _json_ready(value) for key, value in asdict(payload).items()}
    if isinstance(payload, dict):
        return {str(key): _json_ready(value) for key, value in payload.items()}
    if isinstance(payload, list):
        return [_json_ready(item) for item in payload]
    if isinstance(payload, tuple):
        return [_json_ready(item) for item in payload]
    if isinstance(payload, Path):
        return str(payload)
    if isinstance(payload, datetime):
        return payload.isoformat()
    return payload
