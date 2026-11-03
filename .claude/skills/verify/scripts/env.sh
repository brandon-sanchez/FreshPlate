# Shared settings for the verify helpers. Source it; don't execute it.
# Every value can be overridden from the environment before sourcing.

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
SKILL_DIR="$REPO_ROOT/.claude/skills/verify"

# The simulator that has Expo Go 54 (matches Expo SDK 54) and Brandon's
# signed-in FreshPlate session. Sign-in is Google/Apple OAuth only, so a
# different device starts signed out and cannot be driven past the login screen.
VERIFY_UDID="${VERIFY_UDID:-60ACCFBE-1E1D-4C9B-A88E-497999D8DB5F}"
EXPO_GO_BUNDLE_ID="host.exp.Exponent"

API_PORT="${API_PORT:-8000}"
METRO_PORT="${METRO_PORT:-8081}"
EXP_URL="exp://127.0.0.1:$METRO_PORT"

# Evidence lives here and survives cleanup. `.verify/` is gitignored.
RUNS_DIR="$REPO_ROOT/.verify/runs"
CURRENT_RUN="$REPO_ROOT/.verify/current"
# Processes and devices this skill started, so cleanup only stops those.
STATE_DIR="$REPO_ROOT/.verify/state"

run_dir() {
  if [ ! -L "$CURRENT_RUN" ]; then
    echo "no active run; run launch.sh first" >&2
    return 1
  fi
  readlink "$CURRENT_RUN"
}

port_pid() {
  { lsof -nP -iTCP:"$1" -sTCP:LISTEN -t 2>/dev/null || true; } | head -1
}

pid_cwd() {
  { lsof -a -p "$1" -d cwd -Fn 2>/dev/null || true; } | sed -n 's/^n//p'
}

# Every checkout and worktree shares one simulator, one Supabase household and
# fixed ports, so only one verification run may drive the app at a time. The
# lock lives in the git common directory, which all worktrees of the repo see.
LOCK_DIR="$(git -C "$REPO_ROOT" rev-parse --path-format=absolute --git-common-dir)/verify.lock"
STALE_LOCK_SECONDS=300

lock_holder() {
  sed -n 1p "$LOCK_DIR/owner" 2>/dev/null
}

acquire_lock() {
  if mkdir "$LOCK_DIR" 2>/dev/null; then
    printf '%s\n%s\n' "$REPO_ROOT" "$(date '+%F %T')" > "$LOCK_DIR/owner"
    return 0
  fi
  local holder since age
  holder=$(lock_holder)
  since=$(sed -n 2p "$LOCK_DIR/owner" 2>/dev/null)
  [ "$holder" = "$REPO_ROOT" ] && return 0
  # A holder that crashed before cleanup leaves the lock behind. Treat it as
  # stale only once it is old enough that its launch must have finished and
  # nothing is serving the app anymore.
  age=$(( $(date +%s) - $(stat -f %m "$LOCK_DIR/owner" 2>/dev/null || date +%s) ))
  if [ "$age" -gt "$STALE_LOCK_SECONDS" ] && [ -z "$(port_pid "$API_PORT")" ] && [ -z "$(port_pid "$METRO_PORT")" ]; then
    echo "verify lock: taking over a stale lock from $holder (held since $since; nothing is serving the app)" >&2
    printf '%s\n%s\n' "$REPO_ROOT" "$(date '+%F %T')" > "$LOCK_DIR/owner"
    return 0
  fi
  echo "verify lock: the simulator is in use by $holder (since $since)." >&2
  echo "Wait and run launch.sh again in a few minutes. Never stop its servers or delete its lock." >&2
  return 1
}

release_lock() {
  if [ "$(lock_holder)" = "$REPO_ROOT" ]; then
    rm -rf "$LOCK_DIR"
    echo "verify lock: released"
  fi
}
