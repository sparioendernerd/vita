from __future__ import annotations

from .workflow import build_parser, run_step


def main(step_name: str) -> int:
    parser = build_parser(step_name)
    args = parser.parse_args()
    return run_step(step_name, args)
