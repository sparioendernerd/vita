#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Set these locally on the gateway. Do not commit your real values.
export MORNING_BRIEF_WEATHER_LABEL="${MORNING_BRIEF_WEATHER_LABEL:-"White Plains, NY"}"
export MORNING_BRIEF_WEATHER_LATITUDE="${MORNING_BRIEF_WEATHER_LATITUDE:-"41.0109"}"
export MORNING_BRIEF_WEATHER_LONGITUDE="${MORNING_BRIEF_WEATHER_LONGITUDE:-"-73.7505"}"

if [[ "$MORNING_BRIEF_WEATHER_LABEL" == "CHANGE_ME" ]] || [[ "$MORNING_BRIEF_WEATHER_LATITUDE" == "CHANGE_ME" ]] || [[ "$MORNING_BRIEF_WEATHER_LONGITUDE" == "CHANGE_ME" ]]; then
  echo "Morning Brief weather environment is not configured."
  echo "Edit $ROOT_DIR/morning_brief_test.sh or export these before running:"
  echo "  MORNING_BRIEF_WEATHER_LABEL"
  echo "  MORNING_BRIEF_WEATHER_LATITUDE"
  echo "  MORNING_BRIEF_WEATHER_LONGITUDE"
  exit 1
fi

cd "$ROOT_DIR"
exec python3 morning_brief_test.py "$@"