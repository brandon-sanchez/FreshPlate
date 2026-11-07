#!/usr/bin/env bash
# Save a simulator screenshot into the active run directory.
# Usage: shot.sh <name>   ->  <run>/<NN>-<name>.png (NN keeps them in order)
set -euo pipefail
source "$(dirname "$0")/env.sh"

run=$(run_dir)
n=$(find "$run" -maxdepth 1 -name '*.png' | wc -l | tr -d ' ')
file="$run/$(printf '%02d' "$n")-${1:?usage: shot.sh <name>}.png"
# simctl leaves a 0-byte file behind when capture fails, so never keep one.
if ! xcrun simctl io "$VERIFY_UDID" screenshot "$file" >/dev/null 2>&1 || [ ! -s "$file" ]; then
  rm -f "$file"
  echo "screenshot failed; check the device is still Booted (xcrun simctl list devices | grep $VERIFY_UDID) and rerun launch.sh if not" >&2
  exit 1
fi
echo "$file"
