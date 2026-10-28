#!/usr/bin/env bash
# Stop only what launch.sh started. Reused servers and a simulator that was
# already booted are left running. Evidence in .verify/runs/ is never deleted.
set -uo pipefail
source "$(dirname "$0")/env.sh"

for label in metro api; do
  pidfile="$STATE_DIR/$label.pid"
  [ -f "$pidfile" ] || continue
  pid=$(cat "$pidfile")
  # spawn.py made the PID a process-group leader; signal the whole group so
  # uvicorn's reloader child and Metro's workers exit too.
  if kill -0 "$pid" 2>/dev/null; then
    kill -TERM -- "-$pid" 2>/dev/null
    for _ in $(seq 1 10); do kill -0 "$pid" 2>/dev/null || break; sleep 1; done
    kill -0 "$pid" 2>/dev/null && kill -KILL -- "-$pid" 2>/dev/null
    echo "$label: stopped pid $pid"
  fi
  rm -f "$pidfile" "$STATE_DIR/$label.log"
done

if [ -f "$STATE_DIR/booted-sim" ]; then
  xcrun simctl shutdown "$(cat "$STATE_DIR/booted-sim")" 2>/dev/null && echo "simulator: shut down"
  rm -f "$STATE_DIR/booted-sim"
fi

if run=$(readlink "$CURRENT_RUN" 2>/dev/null); then
  echo "evidence kept in $run"
  ls "$run"
fi
