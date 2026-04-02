from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parent

STEPS = {
    "collect_tasks": ROOT / "scripts" / "morning_brief_collect_tasks" / "main.py",
    "research_news": ROOT / "scripts" / "morning_brief_research_news" / "main.py",
    "collect_weather": ROOT / "scripts" / "morning_brief_collect_weather" / "main.py",
    "select_song": ROOT / "scripts" / "morning_brief_select_song" / "main.py",
    "build_script": ROOT / "scripts" / "morning_brief_build_script" / "main.py",
    "deliver": ROOT / "scripts" / "morning_brief_deliver" / "main.py",
}

SEQUENCES = {
    "prep": ["collect_tasks", "research_news", "collect_weather", "select_song", "build_script"],
    "song_only": ["deliver"],
    "tts_only": ["deliver"],
    "full": ["collect_tasks", "research_news", "collect_weather", "select_song", "build_script", "deliver"],
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Run a Morning Brief test sequence from the project root."
    )
    parser.add_argument(
        "--date",
        default=None,
        help="Optional local date key in YYYY-MM-DD format.",
    )
    parser.add_argument(
        "--mode",
        choices=sorted(SEQUENCES),
        default="full",
        help="Which test sequence to run.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Use delivery dry-run mode when the sequence includes the deliver step.",
    )
    parser.add_argument(
        "--live",
        action="store_true",
        help="Allow live delivery. Without this, delivery defaults to dry-run for safety.",
    )
    parser.add_argument(
        "--keep-going",
        action="store_true",
        help="Continue running later steps even if an earlier one fails.",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    steps = SEQUENCES[args.mode]
    failures = 0

    print(f"Morning Brief test mode: {args.mode}")
    if args.date:
        print(f"Date: {args.date}")

    for step in steps:
        command = build_command(step, args)
        print(f"\n==> Running {step}")
        print(" ".join(_quote(arg) for arg in command))

        completed = subprocess.run(command, cwd=str(ROOT), check=False)
        if completed.returncode == 0:
            print(f"<== {step} succeeded")
            continue

        failures += 1
        print(f"<== {step} failed with exit code {completed.returncode}")
        if not args.keep_going:
            return completed.returncode

    if failures:
        return 1
    return 0


def build_command(step: str, args: argparse.Namespace) -> list[str]:
    command = [sys.executable, str(STEPS[step])]
    if args.date:
        command.extend(["--date", args.date])

    if step == "deliver":
        if args.mode == "song_only":
            command.append("--skip-tts")
        elif args.mode == "tts_only":
            command.append("--skip-playback")

        if args.dry_run or not args.live:
            command.append("--dry-run")

    return command


def _quote(value: str) -> str:
    if " " in value or "\t" in value:
        return f"\"{value}\""
    return value


if __name__ == "__main__":
    raise SystemExit(main())
