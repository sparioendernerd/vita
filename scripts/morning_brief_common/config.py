from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path

from .utils import ensure_dir, now_in_timezone, resolve_env_path


@dataclass(frozen=True)
class MorningBriefConfig:
    vita_name: str
    vita_display_name: str
    vita_personality: str
    vita_voice_prompt: str
    playlist_url: str
    playlist_id: str
    vault_path_gateway: str
    vault_path_windows_mirror: str
    weather_label: str
    weather_latitude: float | None
    weather_longitude: float | None
    timezone: str
    interest_profile: list[str]
    song_history_cooldown_days: int
    news_repeat_lookback_days: int
    news_feed_urls: list[str]
    browser_open_command: str
    browser_play_command: str
    browser_close_command: str
    browser_start_delay_seconds: int
    playback_buffer_seconds: int
    audio_player_command: str
    tts_model: str
    tts_voice_name: str
    scripts_root: Path
    runtime_root: Path
    local_config_path: Path
    gateway_vita_config_path: Path
    resolved_vault_path: Path
    gemini_api_key: str | None
    text_model: str


def load_config() -> MorningBriefConfig:
    common_root = Path(__file__).resolve().parent
    scripts_root = common_root.parent
    runtime_root = scripts_root / "morning_brief_runtime"
    local_config_path = common_root / "config.json"
    raw = json.loads(local_config_path.read_text(encoding="utf-8"))
    vita_name = os.environ.get("VITA_NAME", str(raw.get("vita_name") or "graves")).strip().lower()
    gateway_vita_config_path = Path.home() / ".vita" / vita_name / "config.json"

    text_model = "gemini-3-flash-preview"
    tts_voice_name = str(raw.get("tts_voice_name", "Algieba"))
    env_tts_voice_name = os.environ.get("MORNING_BRIEF_TTS_VOICE", "").strip()
    vita_display_name = vita_name.replace("_", " ").title()
    vita_personality = ""
    vita_voice_prompt = ""
    if gateway_vita_config_path.exists():
        try:
            vita_raw = json.loads(gateway_vita_config_path.read_text(encoding="utf-8"))
            text_model = str(vita_raw.get("textModel") or text_model)
            tts_voice_name = str(vita_raw.get("voiceName") or tts_voice_name)
            vita_display_name = str(vita_raw.get("displayName") or vita_display_name)
            vita_personality = str(vita_raw.get("personality") or "")
            vita_voice_prompt = str(vita_raw.get("voicePrompt") or "")
        except Exception:
            pass

    vault_gateway = os.environ.get("MORNING_BRIEF_VAULT_PATH", str(raw["vault_path_gateway"]))
    vault_windows = os.environ.get("MORNING_BRIEF_LOCAL_VAULT_MIRROR", str(raw["vault_path_windows_mirror"]))
    resolved_vault_path = _resolve_vault_path(vault_gateway, vault_windows)

    ensure_dir(runtime_root)

    return MorningBriefConfig(
        vita_name=vita_name,
        vita_display_name=vita_display_name,
        vita_personality=vita_personality,
        vita_voice_prompt=vita_voice_prompt,
        playlist_url=str(raw["playlist_url"]),
        playlist_id=str(raw["playlist_id"]),
        vault_path_gateway=vault_gateway,
        vault_path_windows_mirror=vault_windows,
        weather_label=os.environ.get("MORNING_BRIEF_WEATHER_LABEL", str(raw["weather"].get("label") or "")).strip(),
        weather_latitude=_optional_float(os.environ.get("MORNING_BRIEF_WEATHER_LATITUDE"), raw["weather"].get("latitude")),
        weather_longitude=_optional_float(os.environ.get("MORNING_BRIEF_WEATHER_LONGITUDE"), raw["weather"].get("longitude")),
        timezone=os.environ.get("MORNING_BRIEF_TIMEZONE", str(raw["timezone"])),
        interest_profile=[str(item) for item in raw["interest_profile"]],
        song_history_cooldown_days=int(raw["song_history_cooldown_days"]),
        news_repeat_lookback_days=int(raw["news_repeat_lookback_days"]),
        news_feed_urls=[str(item) for item in raw["news_feed_urls"]],
        browser_open_command=os.environ.get("MORNING_BRIEF_BROWSER_COMMAND", str(raw["browser_open_command"])),
        browser_play_command=os.environ.get("MORNING_BRIEF_BROWSER_PLAY_COMMAND", str(raw.get("browser_play_command") or "")),
        browser_close_command=os.environ.get("MORNING_BRIEF_BROWSER_CLOSE_COMMAND", str(raw.get("browser_close_command") or "")),
        browser_start_delay_seconds=int(os.environ.get("MORNING_BRIEF_BROWSER_START_DELAY", str(raw["browser_start_delay_seconds"]))),
        playback_buffer_seconds=int(os.environ.get("MORNING_BRIEF_PLAYBACK_BUFFER", str(raw["playback_buffer_seconds"]))),
        audio_player_command=os.environ.get("MORNING_BRIEF_AUDIO_PLAYER", str(raw["audio_player_command"])),
        tts_model=os.environ.get("MORNING_BRIEF_TTS_MODEL", str(raw["tts_model"])),
        tts_voice_name=tts_voice_name if gateway_vita_config_path.exists() else (env_tts_voice_name or tts_voice_name),
        scripts_root=scripts_root,
        runtime_root=runtime_root,
        local_config_path=local_config_path,
        gateway_vita_config_path=gateway_vita_config_path,
        resolved_vault_path=resolved_vault_path,
        gemini_api_key=os.environ.get("GEMINI_API_KEY") or None,
        text_model=os.environ.get("MORNING_BRIEF_TEXT_MODEL", text_model),
    )


def resolve_date_key(config: MorningBriefConfig, requested: str | None = None) -> str:
    if requested:
        return requested
    return now_in_timezone(config.timezone).date().isoformat()


def get_daily_dir(config: MorningBriefConfig, date_key: str) -> Path:
    return ensure_dir(config.runtime_root / date_key)


def _resolve_vault_path(gateway_value: str, windows_value: str) -> Path:
    candidates = [Path(resolve_env_path(gateway_value)), Path(resolve_env_path(windows_value))]
    for candidate in candidates:
        if candidate.exists():
            return candidate
    return candidates[0]


def _optional_float(env_value: str | None, fallback: object) -> float | None:
    value = env_value if env_value not in (None, "") else fallback
    if value in (None, ""):
        return None
    return float(value)
