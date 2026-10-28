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
