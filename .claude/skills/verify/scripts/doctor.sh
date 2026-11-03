#!/usr/bin/env bash
# Read-only health check: is this FreshPlate instance worth driving?
# Exits non-zero if any check fails. Changes nothing.
set -uo pipefail
source "$(dirname "$0")/env.sh"

failed=0
ok()   { echo "ok    $*"; }
bad()  { echo "FAIL  $*"; failed=1; }
warn() { echo "warn  $*"; }

# Simulator
if xcrun simctl list devices | grep "$VERIFY_UDID" | grep -q Booted; then
  ok "simulator $VERIFY_UDID booted"
else
  bad "simulator $VERIFY_UDID not booted (run launch.sh)"
fi
expo_go=$(xcrun simctl listapps "$VERIFY_UDID" 2>/dev/null | grep -A12 "\"$EXPO_GO_BUNDLE_ID\"" | sed -n 's/.*CFBundleVersion = "\(.*\)";/\1/p' | head -1)
case "$expo_go" in
  54.*) ok "Expo Go $expo_go (SDK 54)" ;;
  "")   bad "Expo Go not installed on $VERIFY_UDID" ;;
  *)    bad "Expo Go $expo_go does not match Expo SDK 54" ;;
esac

# Backend: right process, right repo, answering.
pid=$(port_pid "$API_PORT")
if [ -z "$pid" ]; then
  bad "nothing listening on :$API_PORT"
elif [[ "$(pid_cwd "$pid")" != "$REPO_ROOT/backend"* ]]; then
  bad ":$API_PORT is pid $pid from $(pid_cwd "$pid"), not this repo's backend"
elif curl -sf "http://127.0.0.1:$API_PORT/health" | grep -q freshplate-api; then
  ok "API pid $pid healthy on :$API_PORT"
else
  bad "API pid $pid on :$API_PORT is not answering /health"
fi

# Metro
pid=$(port_pid "$METRO_PORT")
if [ -z "$pid" ]; then
  bad "nothing listening on :$METRO_PORT"
elif [[ "$(pid_cwd "$pid")" != "$REPO_ROOT/mobile"* ]]; then
  bad ":$METRO_PORT is pid $pid from $(pid_cwd "$pid"), not this repo's mobile app"
elif curl -sf "http://127.0.0.1:$METRO_PORT/status" | grep -q packager-status:running; then
  ok "Metro pid $pid running on :$METRO_PORT"
else
  bad "Metro pid $pid on :$METRO_PORT is not answering /status"
fi

# The app calls the API at EXPO_PUBLIC_API_URL. A LAN IP goes stale when the
# Mac changes networks, and every AI call then fails as a network error.
api_url=$(sed -n 's/^EXPO_PUBLIC_API_URL=//p' "$REPO_ROOT/mobile/.env" 2>/dev/null)
api_host=$(echo "$api_url" | sed -E 's#^[a-z]+://([^:/]+).*#\1#')
if [ -z "$api_url" ]; then
  bad "EXPO_PUBLIC_API_URL missing from mobile/.env"
elif [ "$api_host" = localhost ] || [ "$api_host" = 127.0.0.1 ]; then
  ok "app API URL $api_url"
elif ifconfig | grep -q "inet $api_host "; then
  ok "app API URL $api_url matches this Mac's address"
else
  bad "app API URL $api_url is not an address of this Mac; fix mobile/.env and restart Metro"
fi
if curl -sf "$api_url/health" >/dev/null 2>&1; then
  ok "API reachable at $api_url"
else
  bad "API not reachable at $api_url"
fi

# Supabase. Free-tier projects pause after about a week without traffic; a
# paused project's hostname stops resolving and the app hangs on loaders.
sb_url=$(sed -n 's/^EXPO_PUBLIC_SUPABASE_URL=//p' "$REPO_ROOT/mobile/.env" 2>/dev/null)
sb_code=$(curl -s -m 10 -o /dev/null -w '%{http_code}' "$sb_url/auth/v1/health")
if [ "$sb_code" = 000 ]; then
  bad "Supabase $sb_url unreachable; the project is probably paused (supabase projects list -o json shows INACTIVE). Brandon restores it from the dashboard."
elif [ "$sb_code" -ge 500 ]; then
  # 4xx is expected here because the request sends no apikey; 5xx means the
  # project answered but its Auth service is unhealthy.
  bad "Supabase $sb_url answered HTTP $sb_code; its Auth service is unhealthy"
else
  ok "Supabase reachable (HTTP $sb_code)"
fi

# Signed-in session. Reads only the user id and whether a refresh token exists;
# token values are never printed.
data=$(xcrun simctl get_app_container "$VERIFY_UDID" "$EXPO_GO_BUNDLE_ID" data 2>/dev/null)
store=$(ls -d "$data"/Documents/ExponentExperienceData/@anonymous/mobile-*/RCTAsyncLocalStorage 2>/dev/null | head -1)
if [ -z "$store" ]; then
  bad "no FreshPlate storage in Expo Go; Brandon must open the app and sign in once"
else
  session=$(python3 -I - "$store" <<'EOF'
import hashlib, json, os, sys
store = sys.argv[1]
manifest = json.load(open(os.path.join(store, "manifest.json")))
for key, value in manifest.items():
    if not key.endswith("-auth-token"):
        continue
    if value is None:  # large values live in a file named by the key's md5
        path = os.path.join(store, hashlib.md5(key.encode()).hexdigest())
        value = open(path).read() if os.path.exists(path) else None
    if value:
        session = json.loads(value)
        if session.get("refresh_token"):
            print(session.get("user", {}).get("id", "unknown"))
EOF
)
  if [ -n "$session" ]; then
    ok "stored session for user $session (screenshot still decides: login screen means it was revoked)"
  else
    bad "signed out; Brandon must sign in with Google or Apple on the simulator"
  fi
fi

holder=$(lock_holder)
if [ -z "$holder" ]; then
  warn "verify lock is free (run launch.sh to take it)"
elif [ "$holder" = "$REPO_ROOT" ]; then
  ok "verify lock held by this checkout"
else
  bad "verify lock held by $holder; another session is driving the app"
fi

run=$(readlink "$CURRENT_RUN" 2>/dev/null) && ok "evidence dir $run" || warn "no active run dir"
exit $failed
