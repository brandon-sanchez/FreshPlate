#!/usr/bin/env bash
# Stop only what launch.sh started. Reused servers and a simulator that was
# already booted are left running. Evidence in .verify/runs/ is never deleted.
set -uo pipefail
source "$(dirname "$0")/env.sh"

# A recording left running would hold the simulator's screen. SIGINT makes
# simctl write a playable file; no GIF is made from an abandoned clip.
if [ -f "$STATE_DIR/record.pid" ]; then
  pid=$(cat "$STATE_DIR/record.pid")
  if kill -0 "$pid" 2>/dev/null; then
    kill -INT "$pid" 2>/dev/null
    for _ in $(seq 1 10); do kill -0 "$pid" 2>/dev/null || break; sleep 1; done
    echo "recording: stopped pid $pid"
  fi
  rm -f "$STATE_DIR/record.pid" "$STATE_DIR/record.name"
fi

for label in metro api; do
  pidfile="$STATE_DIR/$label.pid"
  [ -f "$pidfile" ] || continue
  pid=$(cat "$pidfile")
  case $label in
    api) expected="$REPO_ROOT/backend" ;;
    metro) expected="$REPO_ROOT/mobile" ;;
  esac
  # A server that exited on its own leaves its PID file behind, and the OS can
  # hand that PID to an unrelated process. Only signal a PID that still runs
  # from this checkout's server directory.
  if kill -0 "$pid" 2>/dev/null && [[ "$(pid_cwd "$pid")" != "$expected"* ]]; then
    echo "$label: pid $pid is no longer this checkout's server; dropping its stale PID file"
    rm -f "$pidfile" "$STATE_DIR/$label.log"
    continue
  fi
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

release_lock

if run=$(readlink "$CURRENT_RUN" 2>/dev/null); then
  echo "evidence kept in $run"
  ls "$run"
fi
