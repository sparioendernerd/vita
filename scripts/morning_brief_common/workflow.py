from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import time
import wave
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse
from urllib.request import urlopen

from .config import MorningBriefConfig, get_daily_dir, load_config, resolve_date_key
from .gemini import GeminiClient, GeminiError
from .utils import (
    append_jsonl,
    normalize_whitespace,
    now_in_timezone,
    read_json,
    read_jsonl,
    read_text,
    shell_quote,
    stable_hash,
    write_json,
    write_text,
)
from .vault import collect_task_snapshot, read_recent_memory_snippets


def build_parser(step_name: str) -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=f"Morning Brief step: {step_name}")
    parser.add_argument("--date", dest="date_key", default=None, help="Local date key in YYYY-MM-DD format.")
    parser.add_argument("--dry-run", action="store_true", help="Do not perform external side effects where possible.")
    parser.add_argument("--skip-playback", action="store_true", help="Skip song playback during delivery.")
    parser.add_argument("--skip-tts", action="store_true", help="Skip TTS generation/playback during delivery.")
    return parser


def run_step(step_name: str, args: argparse.Namespace) -> int:
    config = load_config()
    date_key = resolve_date_key(config, args.date_key)
    try:
        if step_name == "collect_tasks":
            result = collect_tasks(config, date_key)
        elif step_name == "research_news":
            result = research_news(config, date_key)
        elif step_name == "collect_weather":
            result = collect_weather(config, date_key)
        elif step_name == "select_song":
            result = select_song(config, date_key)
        elif step_name == "build_script":
            result = build_script(config, date_key)
        elif step_name == "deliver":
            result = deliver(
                config,
                date_key,
                dry_run=args.dry_run,
                skip_playback=args.skip_playback,
                skip_tts=args.skip_tts,
            )
        else:
            raise ValueError(f"Unknown Morning Brief step: {step_name}")
    except Exception as exc:
        result = {
            "status": "error",
            "step": step_name,
            "date": date_key,
            "error": str(exc),
            "generated_at": now_in_timezone(config.timezone).isoformat(),
        }
        _append_run_log(config, date_key, result)
        print(json.dumps(result, indent=2))
        return 1

    _append_run_log(config, date_key, result)
    print(json.dumps(result, indent=2, ensure_ascii=False))
    return 0 if result.get("status") != "error" else 1


def collect_tasks(config: MorningBriefConfig, date_key: str) -> dict[str, Any]:
    target_day = datetime.strptime(date_key, "%Y-%m-%d").date()
    snapshot = collect_task_snapshot(config.resolved_vault_path, target_day)
    memories = read_recent_memory_snippets(_memory_db_path(config), config.vita_name, limit=8)

    summary = {
        "what_we_accomplished_yesterday": snapshot["yesterday_completed"][:6],
        "what_we_are_doing_today": snapshot["today_active"][:6],
        "active_projects": snapshot["project_active"][:8],
        "carryovers": snapshot["carryovers"][:8],
        "blocked_or_on_hold": snapshot["blocked_or_on_hold"][:8],
        "recent_memory_snippets": memories,
    }

    payload = {
        "status": "ok",
        "step": "collect_tasks",
        "generated_at": now_in_timezone(config.timezone).isoformat(),
        "source_inputs": {
            "vault_path": str(config.resolved_vault_path),
            "memory_db_path": str(_memory_db_path(config)),
        },
        "snapshot": snapshot,
        "summary": summary,
    }
    write_json(get_daily_dir(config, date_key) / "tasks.json", payload)
    return payload


def research_news(config: MorningBriefConfig, date_key: str) -> dict[str, Any]:
    daily_dir = get_daily_dir(config, date_key)
    history_rows = read_jsonl(config.runtime_root / "news_log.jsonl")
    cutoff = now_in_timezone(config.timezone) - timedelta(days=config.news_repeat_lookback_days)
    recent_hashes = {
        row["fingerprint"]
        for row in history_rows
        if row.get("fingerprint") and _safe_parse_datetime(row.get("used_at")) and _safe_parse_datetime(row.get("used_at")) >= cutoff
    }

    candidates: list[dict[str, Any]] = []
    query_log: list[dict[str, Any]] = []
    for feed_url in config.news_feed_urls:
        result = _fetch_feed(feed_url)
        query_log.append({"feed_url": feed_url, "status": result["status"], "count": len(result["items"])})
        candidates.extend(result["items"])

    deduped: list[dict[str, Any]] = []
    seen: set[str] = set()
    rejected: list[dict[str, Any]] = []
    for item in candidates:
        fingerprint = stable_hash(item.get("canonical_url", ""), item.get("title", ""), item.get("source", ""))
        item["fingerprint"] = fingerprint
        if fingerprint in seen:
            rejected.append({"headline": item.get("title"), "reason": "duplicate candidate", "fingerprint": fingerprint})
            continue
        seen.add(fingerprint)
        if fingerprint in recent_hashes:
            rejected.append({"headline": item.get("title"), "reason": "recently used", "fingerprint": fingerprint})
            continue
        deduped.append(item)

    selected = deduped[:3]
    llm_error: str | None = None
    if config.gemini_api_key and deduped:
        try:
            selected, llm_rejections = _rank_news_with_gemini(config, deduped, history_rows)
            rejected.extend(llm_rejections)
        except Exception as exc:
            llm_error = str(exc)
            selected = deduped[:3]
    else:
        rejected.extend({"headline": item.get("title"), "reason": "not selected by fallback ranking", "fingerprint": item.get("fingerprint")} for item in deduped[3:])
        for story in selected:
            story["summary"] = _fallback_story_summary(story)
            story["why_it_matters"] = _fallback_story_why(story)

    payload = {
        "status": "ok" if query_log else "error",
        "step": "research_news",
        "generated_at": now_in_timezone(config.timezone).isoformat(),
        "source_inputs": {
            "interest_profile": config.interest_profile,
            "news_feed_urls": config.news_feed_urls,
            "news_repeat_lookback_days": config.news_repeat_lookback_days,
        },
        "query_log": query_log,
        "selected_stories": selected,
        "rejected_stories": rejected,
        "llm_error": llm_error,
    }
    write_json(daily_dir / "research.json", payload)
    return payload


def collect_weather(config: MorningBriefConfig, date_key: str) -> dict[str, Any]:
    daily_dir = get_daily_dir(config, date_key)
    if config.weather_latitude is None or config.weather_longitude is None:
        raise RuntimeError(
            "Morning Brief weather location is not configured. Set MORNING_BRIEF_WEATHER_LABEL, "
            "MORNING_BRIEF_WEATHER_LATITUDE, and MORNING_BRIEF_WEATHER_LONGITUDE in the environment."
        )

    location_label = config.weather_label or "Configured location"
    url = (
        "https://api.open-meteo.com/v1/forecast"
        f"?latitude={config.weather_latitude}"
        f"&longitude={config.weather_longitude}"
        "&current=temperature_2m,weather_code"
        "&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max"
        "&timezone=auto"
        "&forecast_days=1"
    )
    with urlopen(url, timeout=30) as response:
        payload = json.loads(response.read().decode("utf-8"))

    current = payload.get("current", {})
    daily = payload.get("daily", {})
    weather = {
        "status": "ok",
        "step": "collect_weather",
        "generated_at": now_in_timezone(config.timezone).isoformat(),
        "source_inputs": {
            "location": location_label,
            "latitude": config.weather_latitude,
            "longitude": config.weather_longitude,
        },
        "forecast": {
            "location": location_label,
            "current_temperature_f": _c_to_f(current.get("temperature_2m")),
            "high_f": _c_to_f(_first_or_none(daily.get("temperature_2m_max"))),
            "low_f": _c_to_f(_first_or_none(daily.get("temperature_2m_min"))),
            "precipitation_probability_max": _first_or_none(daily.get("precipitation_probability_max")),
            "weather_code": current.get("weather_code"),
            "weather_summary": _weather_code_to_summary(current.get("weather_code")),
            "alert_note": _weather_alert_note(
                _c_to_f(_first_or_none(daily.get("temperature_2m_max"))),
                _c_to_f(_first_or_none(daily.get("temperature_2m_min"))),
                _first_or_none(daily.get("precipitation_probability_max")),
            ),
        },
    }
    write_json(daily_dir / "weather.json", weather)
    return weather


def select_song(config: MorningBriefConfig, date_key: str) -> dict[str, Any]:
    daily_dir = get_daily_dir(config, date_key)
    tasks = read_json(daily_dir / "tasks.json", {})
    weather = read_json(daily_dir / "weather.json", {})
    playlist = _fetch_playlist_tracks(config.playlist_id)
    history_path = config.runtime_root / "song_history.json"
    song_history = read_json(history_path, [])
    recent_song_ids = [entry.get("video_id") for entry in song_history[: config.song_history_cooldown_days * 2]]
    hard_blocked = {entry.get("video_id") for entry in song_history[:1] if entry.get("video_id")}

    eligible_tracks: list[dict[str, Any]] = []
    cooldown_map: dict[str, Any] = {}
    for track in playlist:
        video_id = track.get("video_id")
        if not video_id:
            continue
        recently_played = video_id in recent_song_ids
        blocked = video_id in hard_blocked
        cooldown_map[video_id] = {
            "hard_blocked": blocked,
            "recently_played": recently_played,
        }
        if not blocked:
            eligible_tracks.append(track)

    if not eligible_tracks:
        raise RuntimeError("No eligible tracks were available from the playlist.")

    selected = eligible_tracks[0]
    rationale = "Fallback selection because richer context-based ranking was unavailable."
    if config.gemini_api_key:
        try:
            selected, rationale = _select_song_with_gemini(config, eligible_tracks, tasks, weather, song_history)
        except Exception as exc:
            rationale = f"{rationale} Gemini ranking failed: {exc}"

    payload = {
        "status": "ok",
        "step": "select_song",
        "generated_at": now_in_timezone(config.timezone).isoformat(),
        "source_inputs": {
            "playlist_id": config.playlist_id,
            "playlist_url": config.playlist_url,
            "song_history_path": str(history_path),
        },
        "selected_track": {
            **selected,
            "selection_reason": rationale,
            "recency_check": cooldown_map.get(selected.get("video_id"), {}),
        },
        "eligible_track_count": len(eligible_tracks),
        "rejected_recent_tracks": [
            {"video_id": track_id, **meta}
            for track_id, meta in cooldown_map.items()
            if meta["hard_blocked"] or meta["recently_played"]
        ],
    }
    write_json(daily_dir / "song_selection.json", payload)
    return payload


def build_script(config: MorningBriefConfig, date_key: str) -> dict[str, Any]:
    daily_dir = get_daily_dir(config, date_key)
    tasks = read_json(daily_dir / "tasks.json", {})
    research = read_json(daily_dir / "research.json", {})
    weather = read_json(daily_dir / "weather.json", {})
    song = read_json(daily_dir / "song_selection.json", {})

    brief_context = {
        "song": song.get("selected_track", {}),
        "weather": weather.get("forecast", {}),
        "news": research.get("selected_stories", []),
        "tasks": tasks.get("summary", {}),
        "date": date_key,
    }

    script_text = _build_brief_text(brief_context)
    if config.gemini_api_key:
        try:
            script_text = _polish_brief_with_gemini(config, brief_context)
        except Exception:
            pass

    word_count = len(script_text.split())
    payload = {
        "status": "ok",
        "step": "build_script",
        "generated_at": now_in_timezone(config.timezone).isoformat(),
        "source_inputs": {
            "tasks_path": str(daily_dir / "tasks.json"),
            "research_path": str(daily_dir / "research.json"),
            "weather_path": str(daily_dir / "weather.json"),
            "song_selection_path": str(daily_dir / "song_selection.json"),
        },
        "brief_context": brief_context,
        "estimated_speech_seconds": round((word_count / 145.0) * 60.0),
        "final_script": script_text,
    }
    write_json(daily_dir / "brief_context.json", brief_context)
    write_json(daily_dir / "brief.json", payload)
    write_text(daily_dir / "brief_script.txt", script_text + "\n")
    return payload


def deliver(
    config: MorningBriefConfig,
    date_key: str,
    *,
    dry_run: bool,
    skip_playback: bool,
    skip_tts: bool,
) -> dict[str, Any]:
    daily_dir = get_daily_dir(config, date_key)
    brief_payload = read_json(daily_dir / "brief.json", {})
    if not brief_payload:
        brief_payload = build_script(config, date_key)
    script_text = str(brief_payload.get("final_script") or read_text(daily_dir / "brief_script.txt"))
    song_payload = read_json(daily_dir / "song_selection.json", {})
    selected_track = song_payload.get("selected_track", {})

    playback_result = {"status": "skipped" if skip_playback or dry_run else "pending"}
    tts_result = {"status": "skipped" if skip_tts or dry_run else "pending"}
    errors: list[str] = []

    if not skip_playback and not dry_run:
        try:
            playback_result = _play_song_via_browser(config, selected_track)
        except Exception as exc:
            playback_result = {"status": "error", "error": str(exc)}
            errors.append(f"Song playback failed: {exc}")

    if not skip_tts and not dry_run:
        try:
            tts_result = _speak_brief(config, daily_dir, script_text)
        except Exception as exc:
            tts_result = {"status": "error", "error": str(exc)}
            errors.append(f"TTS failed: {exc}")

    if not dry_run:
        _append_song_history(config, selected_track, date_key)
        _append_news_history(config, brief_payload.get("brief_context", {}).get("news", []), date_key)

    payload = {
        "status": "ok" if not errors else "partial",
        "step": "deliver",
        "generated_at": now_in_timezone(config.timezone).isoformat(),
        "source_inputs": {
            "brief_path": str(daily_dir / "brief_script.txt"),
            "song_selection_path": str(daily_dir / "song_selection.json"),
        },
        "playback": playback_result,
        "tts": tts_result,
        "errors": errors,
        "dry_run": dry_run,
        "skip_playback": skip_playback,
        "skip_tts": skip_tts,
    }
    write_json(daily_dir / "delivery.json", payload)
    return payload


def _rank_news_with_gemini(
    config: MorningBriefConfig,
    candidates: list[dict[str, Any]],
    history_rows: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    client = GeminiClient(config.gemini_api_key or "", config.text_model, config.tts_model)
    compact_candidates = [
        {
            "index": index,
            "title": item.get("title"),
            "source": item.get("source"),
            "canonical_url": item.get("canonical_url"),
            "published": item.get("published"),
            "interest_bucket": item.get("bucket"),
        }
        for index, item in enumerate(candidates)
    ]
    recent_titles = [row.get("title") for row in history_rows[:20] if row.get("title")]
    prompt = (
        "You are selecting morning briefing news for Mr Vailen.\n"
        "Focus on AI assistants, developer tools, games, and adjacent tech culture.\n"
        "Prefer concrete developments, product releases, notable partnerships, and meaningful industry moves.\n"
        "Avoid repetitive, fluffy, or duplicate stories.\n"
        "Return JSON with keys 'selected_indexes' and 'rejections'.\n"
        "'selected_indexes' must be an array of up to 3 candidate indexes in order.\n"
        "'rejections' must be an array of objects with keys 'index' and 'reason'.\n\n"
        f"Recent used titles:\n{json.dumps(recent_titles, ensure_ascii=False)}\n\n"
        f"Candidates:\n{json.dumps(compact_candidates, ensure_ascii=False)}"
    )
    response = client.generate_json(prompt)
    selected_indexes = [int(value) for value in response.get("selected_indexes", [])[:3]]
    selected = [candidates[index] for index in selected_indexes if 0 <= index < len(candidates)]
    if not selected:
        selected = candidates[:3]
    rejected = []
    for item in response.get("rejections", []):
        if not isinstance(item, dict):
            continue
        index = item.get("index")
        if isinstance(index, int) and 0 <= index < len(candidates):
            rejected.append(
                {
                    "headline": candidates[index].get("title"),
                    "reason": item.get("reason", "not selected"),
                    "fingerprint": candidates[index].get("fingerprint"),
                }
            )
    for story in selected:
        summary_prompt = (
            "Summarize this news item for Mr Vailen's morning brief.\n"
            "Return JSON with keys 'summary' and 'why_it_matters'. Keep both concise.\n\n"
            f"Story:\n{json.dumps(story, ensure_ascii=False)}"
        )
        summary_payload = client.generate_json(summary_prompt)
        story["summary"] = str(summary_payload.get("summary") or "").strip()
        story["why_it_matters"] = str(summary_payload.get("why_it_matters") or "").strip()
    return selected, rejected


def _select_song_with_gemini(
    config: MorningBriefConfig,
    tracks: list[dict[str, Any]],
    tasks: dict[str, Any],
    weather: dict[str, Any],
    song_history: list[dict[str, Any]],
) -> tuple[dict[str, Any], str]:
    client = GeminiClient(config.gemini_api_key or "", config.text_model, config.tts_model)
    compact_tracks = [
        {
            "index": index,
            "title": track.get("title"),
            "artist": track.get("artist"),
            "duration_seconds": track.get("duration_seconds"),
        }
        for index, track in enumerate(tracks[:20])
    ]
    prompt = (
        "You are Graves choosing a wake-up song for Mr Vailen.\n"
        "Use the mood of today's work, yesterday's accomplishments, the weather, and recent play history.\n"
        "Avoid anything that feels like a repeat of yesterday.\n"
        "Return JSON with keys 'selected_index' and 'selection_reason'.\n\n"
        f"Tasks summary:\n{json.dumps(tasks.get('summary', {}), ensure_ascii=False)}\n\n"
        f"Weather:\n{json.dumps(weather.get('forecast', {}), ensure_ascii=False)}\n\n"
        f"Recent song history:\n{json.dumps(song_history[:10], ensure_ascii=False)}\n\n"
        f"Candidate tracks:\n{json.dumps(compact_tracks, ensure_ascii=False)}"
    )
    response = client.generate_json(prompt)
    selected_index = int(response.get("selected_index", 0))
    if selected_index < 0 or selected_index >= len(compact_tracks):
        selected_index = 0
    return tracks[selected_index], str(response.get("selection_reason") or "").strip()


def _polish_brief_with_gemini(config: MorningBriefConfig, brief_context: dict[str, Any]) -> str:
    client = GeminiClient(config.gemini_api_key or "", config.text_model, config.tts_model)
    prompt = (
        "You are Graves, Mr Vailen's deadpan technical co-host.\n"
        "Write a concise spoken morning brief in this exact order:\n"
        "1. greeting\n"
        "2. what song played\n"
        "3. why it was picked\n"
        "4. weather\n"
        "5. news\n"
        "6. what we accomplished yesterday\n"
        "7. what we're doing today\n"
        "8. short encouragement\n"
        "Keep it natural, dry, supportive, and under 220 words. No bullet points.\n\n"
        f"Context:\n{json.dumps(brief_context, ensure_ascii=False)}"
    )
    text = client.generate_text(prompt)
    return normalize_whitespace(text.replace("\n", " "))


def _build_brief_text(brief_context: dict[str, Any]) -> str:
    song = brief_context.get("song", {})
    weather = brief_context.get("weather", {})
    news = brief_context.get("news", [])
    tasks = brief_context.get("tasks", {})

    song_title = song.get("title", "something suitably dramatic")
    song_artist = song.get("artist", "an artist known only to the algorithm")
    song_reason = str(song.get("selection_reason", "it felt like the least offensive option for the morning ahead")).rstrip(".")
    weather_summary = weather.get("weather_summary", "weather data is sulking")
    high_f = weather.get("high_f")
    low_f = weather.get("low_f")
    precip = weather.get("precipitation_probability_max")
    alert_note = weather.get("alert_note")

    news_lines = []
    for story in news[:2]:
        title = story.get("title")
        why = story.get("why_it_matters") or story.get("summary")
        if title:
            if why:
                news_lines.append(f"{title}, because {why}")
            else:
                news_lines.append(str(title))

    yesterday = tasks.get("what_we_accomplished_yesterday") or ["nothing neatly filed, which is very on brand"]
    today = tasks.get("what_we_are_doing_today") or ["keep the Morning Brief operation from turning into folklore"]

    weather_line = f"In White Plains, we're looking at {str(weather_summary).lower()}."
    if high_f is not None and low_f is not None:
        weather_line = (
            f"In White Plains, we're looking at {str(weather_summary).lower()}, "
            f"with a high around {high_f} and a low around {low_f}."
        )
    elif high_f is not None:
        weather_line = f"In White Plains, we're looking at {str(weather_summary).lower()}, with a high around {high_f}."
    elif low_f is not None:
        weather_line = f"In White Plains, we're looking at {str(weather_summary).lower()}, with a low around {low_f}."

    pieces = [
        "Good morning, Mr Vailen.",
        f"Your wake-up track was {song_title} by {song_artist}.",
        f"It got the nod because {song_reason}.",
        weather_line,
    ]
    if precip is not None:
        pieces.append(f"Rain odds top out around {precip} percent.")
    if alert_note:
        pieces.append(str(alert_note))
    if news_lines:
        pieces.append("News worth your attention: " + " ".join(news_lines[:2]))
    pieces.append("Yesterday we managed " + ", ".join(yesterday[:3]) + ".")
    pieces.append("Today the main targets are " + ", ".join(today[:3]) + ".")
    pieces.append("Nothing absurdly glamorous, but quite solid work all the same. Let's get after it.")
    return " ".join(normalize_whitespace(part) for part in pieces)


def _fetch_feed(feed_url: str) -> dict[str, Any]:
    try:
        with urlopen(feed_url, timeout=30) as response:
            xml_body = response.read().decode("utf-8", errors="ignore")
    except Exception as exc:
        return {"status": f"error: {exc}", "items": []}

    root = ET.fromstring(xml_body)
    items: list[dict[str, Any]] = []
    for item in root.findall(".//item"):
        title = normalize_whitespace(_xml_text(item.find("title")))
        link = _xml_text(item.find("link"))
        pub_date = _xml_text(item.find("pubDate"))
        source = ""
        source_node = item.find("{http://search.yahoo.com/mrss/}source")
        if source_node is not None and source_node.text:
            source = normalize_whitespace(source_node.text)
        if not source and " - " in title:
            possible_title, possible_source = title.rsplit(" - ", 1)
            if possible_source and len(possible_source) <= 40:
                title = possible_title
                source = possible_source
        items.append(
            {
                "title": title,
                "source": source,
                "link": link,
                "canonical_url": _canonical_news_url(link),
                "published": pub_date,
                "bucket": _bucket_for_story(title),
            }
        )
    return {"status": "ok", "items": items}


def _fetch_playlist_tracks(playlist_id: str) -> list[dict[str, Any]]:
    playlist_url = f"https://www.youtube.com/playlist?list={playlist_id}"
    with urlopen(playlist_url, timeout=60) as response:
        html = response.read().decode("utf-8", errors="ignore")

    initial_data = _extract_json_after_marker(html, "var ytInitialData = ")
    tracks: list[dict[str, Any]] = []
    seen: set[str] = set()
    for renderer in _walk_playlist_renderers(initial_data):
        video_id = renderer.get("videoId")
        if not isinstance(video_id, str) or not video_id or video_id in seen:
            continue
        title = _runs_text(renderer.get("title", {}))
        artist = _runs_text(renderer.get("shortBylineText", {}))
        length_text = renderer.get("lengthText", {}).get("simpleText", "")
        tracks.append(
            {
                "video_id": video_id,
                "title": title,
                "artist": artist,
                "duration_text": length_text,
                "duration_seconds": _duration_to_seconds(length_text),
                "watch_url": f"https://music.youtube.com/watch?v={video_id}&list={playlist_id}",
            }
        )
        seen.add(video_id)
    if not tracks:
        raise RuntimeError("Could not parse any playlist tracks from YouTube.")
    return tracks


def _play_song_via_browser(config: MorningBriefConfig, selected_track: dict[str, Any]) -> dict[str, Any]:
    url = _with_autoplay(str(selected_track.get("watch_url") or ""))
    if not url:
        raise RuntimeError("Selected track did not include a watch URL.")
    command = config.browser_open_command.replace("{{url}}", url)
    process = subprocess.Popen(command, shell=True)
    startup_delay = max(0, int(config.browser_start_delay_seconds))
    duration = int(selected_track.get("duration_seconds") or 0)
    time.sleep(startup_delay)
    play_command = _start_browser_playback(config, url)
    manual_play_triggered = _manual_play_triggered(config, play_command, url)
    if duration > 0 and not manual_play_triggered:
        wait_seconds = max(5, duration - startup_delay)
    else:
        wait_seconds = max(15, duration)
    time.sleep(wait_seconds)
    close_result = _close_browser_playback(config, process, url, selected_track)
    return {
        "status": "ok",
        "command": command,
        "play_command": play_command,
        "close_result": close_result,
        "pid": process.pid,
        "manual_play_triggered": manual_play_triggered,
        "startup_delay_seconds": startup_delay,
        "wait_seconds": wait_seconds,
    }


def _speak_brief(config: MorningBriefConfig, daily_dir: Path, script_text: str) -> dict[str, Any]:
    if not config.gemini_api_key:
        raise GeminiError("GEMINI_API_KEY is required for Morning Brief TTS.")
    client = GeminiClient(config.gemini_api_key, config.text_model, config.tts_model)
    tts_prompt = (
        "Speak this as Graves, a dry British co-host with a calm, posh delivery. "
        "Keep the pacing natural and conversational.\n\n"
        + script_text
    )
    pcm_bytes = client.generate_tts(tts_prompt, voice_name=config.tts_voice_name)
    audio_path = daily_dir / "brief_audio.wav"
    with wave.open(str(audio_path), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(24000)
        handle.writeframes(pcm_bytes)
    play_result = _play_audio_file(config, audio_path)
    return {
        "status": "ok",
        "audio_path": str(audio_path),
        "player": play_result,
    }


def _play_audio_file(config: MorningBriefConfig, audio_path: Path) -> dict[str, Any]:
    if config.audio_player_command:
        command = config.audio_player_command.replace("{{path}}", str(audio_path))
        completed = subprocess.run(command, shell=True, check=False)
        if completed.returncode != 0:
            raise RuntimeError(f"Audio player command failed with exit code {completed.returncode}: {command}")
        return {"command": command}

    candidates = [
        ("ffplay", f"ffplay -nodisp -autoexit {shell_quote(str(audio_path))}"),
        ("paplay", f"paplay {shell_quote(str(audio_path))}"),
        ("pw-play", f"pw-play {shell_quote(str(audio_path))}"),
        ("aplay", f"aplay {shell_quote(str(audio_path))}"),
    ]
    for binary, command in candidates:
        if shutil.which(binary):
            completed = subprocess.run(command, shell=True, check=False)
            if completed.returncode == 0:
                return {"command": command}
    raise RuntimeError(
        "No supported audio player was found. Set MORNING_BRIEF_AUDIO_PLAYER or install ffplay, paplay, pw-play, or aplay."
    )


def _append_song_history(config: MorningBriefConfig, selected_track: dict[str, Any], date_key: str) -> None:
    if not selected_track:
        return
    history_path = config.runtime_root / "song_history.json"
    history = read_json(history_path, [])
    entry = {
        "date": date_key,
        "video_id": selected_track.get("video_id"),
        "title": selected_track.get("title"),
        "artist": selected_track.get("artist"),
        "selection_reason": selected_track.get("selection_reason"),
    }
    history = [entry] + [row for row in history if row.get("date") != date_key]
    write_json(history_path, history[:90])


def _append_news_history(config: MorningBriefConfig, stories: list[dict[str, Any]], date_key: str) -> None:
    history_path = config.runtime_root / "news_log.jsonl"
    used_at = now_in_timezone(config.timezone).isoformat()
    for story in stories:
        append_jsonl(
            history_path,
            {
                "date": date_key,
                "used_at": used_at,
                "fingerprint": story.get("fingerprint"),
                "title": story.get("title"),
                "source": story.get("source"),
                "canonical_url": story.get("canonical_url"),
            },
        )


def _append_run_log(config: MorningBriefConfig, date_key: str, payload: dict[str, Any]) -> None:
    append_jsonl(
        get_daily_dir(config, date_key) / "run_log.jsonl",
        {
            "step": payload.get("step"),
            "status": payload.get("status"),
            "generated_at": payload.get("generated_at"),
            "error": payload.get("error"),
        },
    )


def _start_browser_playback(config: MorningBriefConfig, url: str) -> str | None:
    if config.browser_play_command:
        command = config.browser_play_command.replace("{{url}}", url)
        completed = subprocess.run(command, shell=True, check=False)
        if completed.returncode != 0:
            raise RuntimeError(f"Configured browser play command failed with exit code {completed.returncode}: {command}")
        return command

    if shutil.which("playerctl"):
        status = subprocess.run(
            ["playerctl", "status"],
            capture_output=True,
            text=True,
            check=False,
        )
        if status.returncode == 0 and status.stdout.strip().lower() == "playing":
            return "playerctl status"

        completed = subprocess.run(["playerctl", "play"], check=False)
        if completed.returncode == 0:
            return "playerctl play"

    return None


def _manual_play_triggered(config: MorningBriefConfig, play_command: str | None, url: str) -> bool:
    if not play_command:
        return False
    if play_command == "playerctl status":
        return False
    if config.browser_play_command:
        expected = config.browser_play_command.replace("{{url}}", url)
        if play_command == expected:
            return True
    return play_command == "playerctl play"


def _close_browser_playback(
    config: MorningBriefConfig,
    process: subprocess.Popen[Any],
    url: str,
    selected_track: dict[str, Any],
) -> dict[str, Any]:
    attempts: list[dict[str, Any]] = []

    pause_result = _stop_browser_playback()
    if pause_result is not None:
        attempts.append(pause_result)

    if config.browser_close_command:
        command = config.browser_close_command.replace("{{url}}", url)
        completed = subprocess.run(command, shell=True, check=False)
        if completed.returncode != 0:
            raise RuntimeError(f"Configured browser close command failed with exit code {completed.returncode}: {command}")
        return {"method": "configured_command", "command": command, "attempts": attempts}

    chrome_close = _close_chrome_music_window(url, selected_track)
    if chrome_close is not None:
        chrome_close["attempts"] = attempts
        return chrome_close

    if process.poll() is None:
        process.terminate()
        try:
            process.wait(timeout=5)
            return {"method": "launcher_terminate", "pid": process.pid, "attempts": attempts}
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)
            return {"method": "launcher_kill", "pid": process.pid, "attempts": attempts}

    return {"method": "none", "reason": "launcher_already_exited", "attempts": attempts}


def _stop_browser_playback() -> dict[str, Any] | None:
    if not shutil.which("playerctl"):
        return None

    completed = subprocess.run(["playerctl", "pause"], check=False)
    return {
        "method": "playerctl_pause",
        "returncode": completed.returncode,
    }


def _close_chrome_music_window(url: str, selected_track: dict[str, Any]) -> dict[str, Any] | None:
    title = str(selected_track.get("title") or "").strip()
    title_attempt = _close_window_by_title(title)
    if title_attempt is not None:
        return title_attempt

    music_attempt = _close_window_by_title("YouTube Music")
    if music_attempt is not None:
        return music_attempt

    if not shutil.which("pkill"):
        return None

    parsed = urlparse(url)
    query = parse_qs(parsed.query)
    video_id = ""
    video_values = query.get("v")
    if video_values:
        video_id = str(video_values[0]).strip()

    patterns = []
    if video_id:
        patterns.extend(
            [
                f'chrome.*music.youtube.com/watch.*v={video_id}',
                f'google-chrome.*music.youtube.com/watch.*v={video_id}',
                f'chromium.*music.youtube.com/watch.*v={video_id}',
            ]
        )
    patterns.extend(
        [
            "chrome.*music.youtube.com",
            "google-chrome.*music.youtube.com",
            "chromium.*music.youtube.com",
        ]
    )

    for pattern in patterns:
        completed = subprocess.run(["pkill", "-f", pattern], check=False)
        if completed.returncode == 0:
            return {"method": "pkill", "pattern": pattern}

    return None


def _close_window_by_title(title_fragment: str) -> dict[str, Any] | None:
    normalized = title_fragment.strip()
    if not normalized:
        return None

    if shutil.which("wmctrl"):
        completed = subprocess.run(["wmctrl", "-c", normalized], check=False)
        if completed.returncode == 0:
            return {"method": "wmctrl", "title_fragment": normalized}

    if shutil.which("xdotool"):
        search = subprocess.run(
            ["xdotool", "search", "--onlyvisible", "--name", normalized],
            capture_output=True,
            text=True,
            check=False,
        )
        if search.returncode == 0:
            window_ids = [line.strip() for line in search.stdout.splitlines() if line.strip()]
            for window_id in reversed(window_ids):
                close = subprocess.run(["xdotool", "windowclose", window_id], check=False)
                if close.returncode == 0:
                    return {"method": "xdotool", "title_fragment": normalized, "window_id": window_id}

    return None


def _memory_db_path(config: MorningBriefConfig) -> Path:
    return Path.home() / ".vita" / config.vita_name / "memories.db"


def _first_or_none(values: Any) -> Any:
    if isinstance(values, list) and values:
        return values[0]
    return None


def _c_to_f(value: Any) -> float | None:
    if value is None:
        return None
    try:
        return round((float(value) * 9 / 5) + 32, 1)
    except (TypeError, ValueError):
        return None


def _weather_code_to_summary(code: Any) -> str:
    lookup = {
        0: "Clear skies",
        1: "Mostly clear",
        2: "Partly cloudy",
        3: "Overcast",
        45: "Foggy",
        48: "Depositing rime fog",
        51: "Light drizzle",
        53: "Drizzle",
        55: "Dense drizzle",
        61: "Light rain",
        63: "Rain",
        65: "Heavy rain",
        71: "Light snow",
        73: "Snow",
        75: "Heavy snow",
        80: "Rain showers",
        81: "Steady rain showers",
        82: "Violent rain showers",
        95: "Thunderstorms",
    }
    return lookup.get(code, "Changeable conditions")


def _weather_alert_note(high_f: float | None, low_f: float | None, precip: Any) -> str | None:
    if precip is not None:
        try:
            if float(precip) >= 70:
                return "Umbrella territory, in other words."
        except (TypeError, ValueError):
            pass
    if high_f is not None and high_f >= 85:
        return "It's shaping up warm enough to be annoying."
    if low_f is not None and low_f <= 35:
        return "Bit of a sharp morning, so perhaps don't wander out dressed for optimism."
    return None


def _with_autoplay(url: str) -> str:
    if not url:
        return url
    parsed = urlparse(url)
    query = parse_qs(parsed.query)
    query["autoplay"] = ["1"]
    rebuilt_query = "&".join(
        f"{key}={value}"
        for key, values in query.items()
        for value in values
    )
    return parsed._replace(query=rebuilt_query).geturl()


def _xml_text(node: ET.Element | None) -> str:
    if node is None or node.text is None:
        return ""
    return node.text.strip()


def _bucket_for_story(title: str) -> str:
    lowered = title.lower()
    if any(term in lowered for term in ("ai", "openai", "gemini", "assistant", "model")):
        return "AI"
    if any(term in lowered for term in ("dev", "developer", "programming", "code", "software", "github")):
        return "developer tools"
    if any(term in lowered for term in ("game", "gaming", "steam", "playstation", "xbox", "nintendo")):
        return "games"
    return "adjacent tech"


def _fallback_story_summary(story: dict[str, Any]) -> str:
    bucket = story.get("bucket", "tech")
    title = str(story.get("title") or "A story surfaced")
    return f"{title} is one of the stronger {bucket.lower()} items in the current sweep."


def _fallback_story_why(story: dict[str, Any]) -> str:
    bucket = str(story.get("bucket") or "tech")
    if bucket == "AI":
        return "It touches the assistant and model ecosystem you actually care about."
    if bucket == "developer tools":
        return "It may affect the tools and workflows you build with."
    if bucket == "games":
        return "It lands in the games lane rather than generic industry wallpaper."
    return "It looks more relevant than the usual background noise."


def _canonical_news_url(link: str) -> str:
    if not link:
        return ""
    parsed = urlparse(link)
    if "news.google.com" not in parsed.netloc:
        return link
    query_url = parse_qs(parsed.query).get("url")
    if query_url:
        return query_url[0]
    return link


def _extract_json_after_marker(html: str, marker: str) -> dict[str, Any]:
    start = html.find(marker)
    if start == -1:
        marker = "ytInitialData = "
        start = html.find(marker)
    if start == -1:
        raise RuntimeError("Could not locate playlist JSON in the YouTube page.")
    start = start + len(marker)
    brace_start = html.find("{", start)
    if brace_start == -1:
        raise RuntimeError("Could not locate the opening brace for playlist JSON.")
    depth = 0
    in_string = False
    escaped = False
    for index in range(brace_start, len(html)):
        char = html[index]
        if in_string:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == "\"":
                in_string = False
            continue
        if char == "\"":
            in_string = True
            continue
        if char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                return json.loads(html[brace_start : index + 1])
    raise RuntimeError("Could not extract a complete playlist JSON object.")


def _walk_playlist_renderers(node: Any):
    if isinstance(node, dict):
        if "playlistVideoRenderer" in node:
            yield node["playlistVideoRenderer"]
        for value in node.values():
            yield from _walk_playlist_renderers(value)
    elif isinstance(node, list):
        for item in node:
            yield from _walk_playlist_renderers(item)


def _runs_text(value: Any) -> str:
    if isinstance(value, dict):
        simple_text = value.get("simpleText")
        if isinstance(simple_text, str):
            return simple_text
        runs = value.get("runs")
        if isinstance(runs, list):
            return normalize_whitespace(" ".join(str(run.get("text", "")) for run in runs))
    return ""


def _duration_to_seconds(text: str) -> int:
    if not text:
        return 0
    parts = [int(part) for part in text.split(":") if part.isdigit()]
    if len(parts) == 2:
        return (parts[0] * 60) + parts[1]
    if len(parts) == 3:
        return (parts[0] * 3600) + (parts[1] * 60) + parts[2]
    return 0


def _safe_parse_datetime(value: Any) -> datetime | None:
    if not isinstance(value, str):
        return None
    try:
        return datetime.fromisoformat(value)
    except ValueError:
        return None
