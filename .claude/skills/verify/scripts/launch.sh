#!/usr/bin/env bash
# Start (or reuse) everything a verification run needs, then open FreshPlate
# in Expo Go on the pinned simulator.
#
# Usage: launch.sh [run-name]
# Prints the run directory. Evidence for this run goes there.
set -euo pipefail
source "$(dirname "$0")/env.sh"

name="${1:-run}"
run="$RUNS_DIR/$(date +%Y%m%d-%H%M%S)-$name"
mkdir -p "$run" "$STATE_DIR"
ln -sfn "$run" "$CURRENT_RUN"
note() { echo "$*" | tee -a "$run/launch.log"; }

# Simulator. Only a device this script booted is shut down by cleanup.sh.
state=$(xcrun simctl list devices | grep "$VERIFY_UDID" | sed -E 's/.*\((Booted|Shutdown)\).*/\1/')
if [ "$state" != "Booted" ]; then
  xcrun simctl boot "$VERIFY_UDID"
  echo "$VERIFY_UDID" > "$STATE_DIR/booted-sim"
  note "simulator: booted $VERIFY_UDID"
else
  note "simulator: reused booted $VERIFY_UDID"
fi
xcrun simctl bootstatus "$VERIFY_UDID" -b >/dev/null
# The device is shown in the Claude app's simulator panel (the agent attaches
# it after launch). The standalone Simulator window is only needed for the
# cliclick fallback in sessions without the simulator tool.
if [ "${VERIFY_SIMULATOR_APP:-0}" = 1 ]; then
  open -a Simulator --args -CurrentDeviceUDID "$VERIFY_UDID"
fi

# start_or_reuse <label> <port> <cwd> <ready-check> <command...>
# A process already on the port is reused only if it runs from this repo,
# so a stranger's server on 8000/8081 is never driven or killed.
start_or_reuse() {
  local label=$1 port=$2 cwd=$3 ready=$4; shift 4
  local pid; pid=$(port_pid "$port")
  if [ -n "$pid" ]; then
    local owner; owner=$(pid_cwd "$pid")
    if [[ "$owner" != "$cwd"* ]]; then
      note "$label: port $port is held by pid $pid running from '$owner', not $cwd. Stop it or override its port in env.sh."
      exit 1
    fi
    if [ -e "$STATE_DIR/$label.log" ]; then
      note "$label: reused pid $pid on :$port, started by an earlier verify run; log $(readlink "$STATE_DIR/$label.log")"
    else
      note "$label: reused pid $pid on :$port (its logs are in the terminal that started it, not $run)"
    fi
  else
    pid=$(python3 -I "$SKILL_DIR/scripts/spawn.py" "$run/$label.log" "$cwd" "$@")
    echo "$pid" > "$STATE_DIR/$label.pid"
    ln -sfn "$run/$label.log" "$STATE_DIR/$label.log"
    note "$label: started pid $pid on :$port, log $run/$label.log"
  fi
  for _ in $(seq 1 90); do
    if eval "$ready"; then return 0; fi
    sleep 1
  done
  note "$label: not ready after 90s; last lines of its log:"
  tail -n 15 "$run/$label.log" 2>/dev/null | tee -a "$run/launch.log"
  exit 1
}

start_or_reuse api "$API_PORT" "$REPO_ROOT/backend" \
  "curl -sf http://127.0.0.1:$API_PORT/health >/dev/null" \
  "$REPO_ROOT/backend/venv/bin/uvicorn" app.main:app --host 0.0.0.0 --port "$API_PORT" --reload --reload-dir app

start_or_reuse metro "$METRO_PORT" "$REPO_ROOT/mobile" \
  "curl -sf http://127.0.0.1:$METRO_PORT/status | grep -q packager-status:running" \
  npx expo start --port "$METRO_PORT"

# Relaunch Expo Go on the project so the run starts from a cold JS load.
xcrun simctl terminate "$VERIFY_UDID" "$EXPO_GO_BUNDLE_ID" 2>/dev/null || true
xcrun simctl openurl "$VERIFY_UDID" "$EXP_URL"
note "app: opened $EXP_URL"

# Ready means the JS bundle reached the device. Metro logs "iOS Bundled" when
# it does. A reused Metro's log isn't readable, so fall back to a fixed wait.
metro_log="$STATE_DIR/metro.log"
if [ -f "$STATE_DIR/metro.pid" ] && [ -e "$metro_log" ]; then
  start_lines=$(wc -l < "$metro_log")
  for _ in $(seq 1 180); do
    if tail -n +"$((start_lines + 1))" "$metro_log" | grep -q "iOS Bundled"; then break; fi
    sleep 1
  done
else
  sleep 20
fi
sleep 4
xcrun simctl io "$VERIFY_UDID" screenshot "$run/00-launch.png" >/dev/null 2>&1
note "ready: screenshot $run/00-launch.png (check it shows the tab bar, not the login screen)"
echo "$run"
