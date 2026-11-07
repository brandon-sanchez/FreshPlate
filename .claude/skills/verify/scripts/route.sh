#!/usr/bin/env bash
# Jump straight to an Expo Router route in the running app.
# Usage: route.sh <path>   e.g. route.sh inventory, route.sh item/<uuid>
# Use it to reach a screen quickly; prove navigation itself by tapping.
set -euo pipefail
source "$(dirname "$0")/env.sh"

xcrun simctl openurl "$VERIFY_UDID" "$EXP_URL/--/${1#/}"
