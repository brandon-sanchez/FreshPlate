#!/usr/bin/env bash
# Record the simulator screen and turn the clip into a GIF for a PR.
# Usage:
#   record.sh start <name>   start recording into <run>/<name>.mp4
#   record.sh stop           stop it and write <run>/<name>.gif next to it
# Start right before the action and stop once the result settles, so the GIF
# shows only the interaction (aim for under 15 seconds).
set -euo pipefail
source "$(dirname "$0")/env.sh"

pid_file="$STATE_DIR/record.pid"
name_file="$STATE_DIR/record.name"
mkdir -p "$STATE_DIR"

case "${1:-}" in
  start)
    name="${2:?usage: record.sh start <name>}"
    run=$(run_dir)
    if [ -f "$pid_file" ] && kill -0 "$(cat "$pid_file")" 2>/dev/null; then
      echo "a recording is already running; run record.sh stop first" >&2
      exit 1
    fi
    xcrun simctl io "$VERIFY_UDID" recordVideo --codec h264 --force "$run/$name.mp4" \
      >"$run/$name.record.log" 2>&1 &
    echo $! > "$pid_file"
    echo "$name" > "$name_file"
    # simctl needs a moment before the first frame is written; an action taken
    # sooner is missing from the clip.
    for _ in $(seq 1 50); do
      grep -q "Recording started" "$run/$name.record.log" 2>/dev/null && break
      sleep 0.1
    done
    echo "recording $run/$name.mp4"
    ;;
  stop)
    [ -f "$pid_file" ] || { echo "no recording is running" >&2; exit 1; }
    pid=$(cat "$pid_file")
    name=$(cat "$name_file")
    run=$(run_dir)
    # simctl finalizes the file only on SIGINT; SIGTERM leaves an unplayable mp4.
    kill -INT "$pid" 2>/dev/null || true
    while kill -0 "$pid" 2>/dev/null; do sleep 0.2; done
    rm -f "$pid_file" "$name_file"
    swift "$SKILL_DIR/scripts/gif.swift" "$run/$name.mp4" "$run/$name.gif" \
      "${GIF_FPS:-10}" "${GIF_WIDTH:-440}"
    ;;
  *)
    echo "usage: record.sh start <name> | record.sh stop" >&2
    exit 2
    ;;
esac
