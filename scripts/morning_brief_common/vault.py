from __future__ import annotations

import re
import sqlite3
from dataclasses import dataclass
from datetime import date, timedelta
from pathlib import Path

from .utils import normalize_whitespace, read_text


TASK_LINE = re.compile(r"^\s*[-*]\s+\[(?P<state>[ xX])\]\s+(?P<body>.+?)\s*$")
DATE_HEADING = re.compile(r"^##\s+(?P<date>\d{4}-\d{2}-\d{2})\s*$")


@dataclass(frozen=True)
class ParsedTask:
    text: str
    done: bool
    source_file: str
    project: str | None = None


def collect_task_snapshot(vault_root: Path, target_day: date) -> dict:
    tasks_dir = vault_root / "06_system" / "tasks"
    daily_file = tasks_dir / "daily.md"
    completed_file = tasks_dir / "completed.md"
    projects_dir = tasks_dir / "projects"
    on_hold_dir = tasks_dir / "on-hold projects"

    daily_tasks = _parse_markdown_tasks(daily_file, project=None)
    project_tasks = _parse_project_dir(projects_dir)
    on_hold_tasks = _parse_project_dir(on_hold_dir, on_hold=True)
    yesterday = target_day - timedelta(days=1)

    return {
        "vault_root": str(vault_root),
        "daily_file_found": daily_file.exists(),
        "completed_file_found": completed_file.exists(),
        "yesterday_completed": _read_completed_for_date(completed_file, yesterday.isoformat()),
        "today_active": [task.text for task in daily_tasks if not task.done],
        "project_active": [_task_to_dict(task) for task in project_tasks if not task.done],
        "carryovers": _build_carryovers(daily_tasks, project_tasks),
        "blocked_or_on_hold": [_task_to_dict(task) for task in on_hold_tasks if not task.done],
        "raw_daily_tasks": [_task_to_dict(task) for task in daily_tasks],
    }


def read_recent_memory_snippets(db_path: Path, vita_name: str, limit: int = 8) -> list[str]:
    if not db_path.exists():
        return []

    query = """
        SELECT content
        FROM memories
        WHERE vita_name = ?
          AND category IN ('conversations', 'core')
        ORDER BY timestamp DESC
        LIMIT ?
    """
    with sqlite3.connect(str(db_path)) as connection:
        rows = connection.execute(query, (vita_name, limit)).fetchall()
    return [normalize_whitespace(row[0]) for row in rows if row and row[0]]


def _parse_project_dir(path: Path, on_hold: bool = False) -> list[ParsedTask]:
    if not path.exists():
        return []
    tasks: list[ParsedTask] = []
    for markdown_file in sorted(path.glob("*.md")):
        project_name = markdown_file.stem if not on_hold else f"{markdown_file.stem} (on hold)"
        tasks.extend(_parse_markdown_tasks(markdown_file, project=project_name))
    return tasks


def _parse_markdown_tasks(path: Path, *, project: str | None) -> list[ParsedTask]:
    if not path.exists():
        return []
    tasks: list[ParsedTask] = []
    for raw_line in read_text(path).splitlines():
        match = TASK_LINE.match(raw_line)
        if not match:
            continue
        tasks.append(
            ParsedTask(
                text=normalize_whitespace(match.group("body")),
                done=match.group("state").lower() == "x",
                source_file=str(path),
                project=project,
            )
        )
    return tasks


def _read_completed_for_date(path: Path, target_heading: str) -> list[str]:
    if not path.exists():
        return []
    tasks: list[str] = []
    active = False
    for line in read_text(path).splitlines():
        heading = DATE_HEADING.match(line.strip())
        if heading:
            active = heading.group("date") == target_heading
            continue
        if not active:
            continue
        task_match = TASK_LINE.match(line)
        if task_match and task_match.group("state").lower() == "x":
            tasks.append(normalize_whitespace(task_match.group("body")))
    return tasks


def _build_carryovers(daily_tasks: list[ParsedTask], project_tasks: list[ParsedTask]) -> list[str]:
    carryovers: list[str] = []
    for task in daily_tasks:
        if not task.done:
            carryovers.append(task.text)
    for task in project_tasks:
        if not task.done and task.project:
            carryovers.append(f"{task.text} ({task.project})")
    return carryovers[:12]


def _task_to_dict(task: ParsedTask) -> dict:
    return {
        "text": task.text,
        "done": task.done,
        "source_file": task.source_file,
        "project": task.project,
    }
