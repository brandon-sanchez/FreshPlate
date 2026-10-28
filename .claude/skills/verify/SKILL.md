---
name: verify
description: Launch and drive the FreshPlate Expo app in Expo Go on the iOS simulator, with the local FastAPI backend, to prove a change works the way a user sees it. Use before calling any mobile or API change done, to close a ticket, or whenever a playbook asks to verify in the real app.
---

# Verify FreshPlate in the real app

FreshPlate is an Expo (SDK 54) app that runs in **Expo Go** on an iOS simulator, talks to Supabase directly for inventory, and calls the local FastAPI server for AI features and cooking. A proof means driving that real app, screen by screen, and checking the stored rows that changed.

All helpers live in `.claude/skills/verify/scripts/` and run from the repo root. Settings (device, ports, paths) are in `scripts/env.sh`.

## Ground rules

- **One shared instance.** There is one signed-in simulator, one Supabase project and one household. Two agents can't drive it at once. If `doctor.sh` shows servers you didn't start, they belong to Brandon or another session: reuse them, never kill them.
- **Real data.** Supabase is the hosted project, not a local copy. Every add, delete, save and cook changes Brandon's real household. Name test items `verify-<something>` and remove them at the end of the run.
- **No sign-in by agents.** Sign-in is Google or Apple only. If the app shows the login screen, stop and ask Brandon to sign in on the simulator. Never type credentials.
- **AI calls cost money.** Recipe generation calls Gemini (paid tier) and recipe photos call a paid image API. Generate only when the feature under test needs it, and once per run, not in a loop.

## Launch

```bash
.claude/skills/verify/scripts/launch.sh <run-name>
```

It boots the pinned simulator (`iPhone 17 Pro Max`, iOS 26.3, `60ACCFBE-…`), starts or reuses the API on `:8000` and Metro on `:8081`, cold-opens `exp://127.0.0.1:8081` in Expo Go, waits for Metro to log `iOS Bundled`, and saves `00-launch.png`. It prints the run directory.

**Right after launch, attach the simulator panel** so Brandon can watch the run inside the Claude app: call the iOS Simulator tool with `action: "attach"` and `device: "60ACCFBE-1E1D-4C9B-A88E-497999D8DB5F"`. If it errors because the input connection is still starting, wait about 10 seconds and retry. The standalone Simulator app stays closed unless `VERIFY_SIMULATOR_APP=1` is set for the cliclick fallback.

**Ready** means `00-launch.png` shows the Home screen ("Good afternoon/morning, …", the "What do you want to cook?" card, and the bottom tab bar) with the counts and fridge list loaded. "Loading your fridge…" that never resolves, or a "Network request failed" toast, means not ready: run the doctor.

A server already on a port is reused only if it runs from this repo. If an earlier verify run started it, `launch.sh` prints where its log is (in that earlier run's directory). If Brandon started it, its logs are in his terminal and the run has no `api.log` or `metro.log`.

## Doctor

```bash
.claude/skills/verify/scripts/doctor.sh
```

Read-only. Exits non-zero on any failure. It checks the simulator is booted, Expo Go 54 is installed, that `:8000` and `:8081` belong to this repo and answer, that `EXPO_PUBLIC_API_URL` in `mobile/.env` is an address of this Mac and reachable, that the Supabase project answers, and that a signed-in session is stored (it prints the user id only, never tokens). Run it first whenever anything looks off.

## Drive

**Taps, swipes and typing** go through the iOS Simulator tool (`mcp__Claude_Code_iOS_Simulator__control`, with `device: "60ACCFBE-1E1D-4C9B-A88E-497999D8DB5F"`), which takes **device points**. On this device the screen is 440 × 956 points and screenshots are 1320 × 2868 pixels, so **point = screenshot pixel ÷ 3**. When an image viewer shows the screenshot scaled down, convert from the original pixel size, not the displayed size.

- `tap` at `x, y`. Tab bar centers (y = 872, Add item proven on 2026-10-28): Home x ≈ 56, Inventory x ≈ 138, Add item x = 220 (raised green button), Recipes x ≈ 301, Profile x ≈ 382. The glass bar catches every tap below about y = 820, so scroll content above it before tapping. Re-measure from a screenshot after any tab bar change.
- **First input after a boot fails** with "its input connection is still starting up". Wait about 10 seconds and retry. Then confirm the device is still `Booted` (`xcrun simctl list devices | grep 60ACCFBE`): in the 2026-10-28 proof run the simulator shut down during the tool's first connection. If it did, rerun `launch.sh`, which reuses the running servers, and call the tool's `screenshot` once before the first tap.
- `text` types into the focused field. Tap the field first.
- `swipe` scrolls lists and the recipe carousel. Start more than 4 pt from any edge, or iOS treats it as a system edge gesture.

If the simulator tool isn't available (plain CLI sessions), launch with `VERIFY_SIMULATOR_APP=1` and fall back to `cliclick` on the Simulator window. Activate Simulator before every tap (`osascript -e 'tell application "Simulator" to activate'`), move the mouse between repeated taps at one spot, and compute window coordinates from `CGWindowListCopyWindowInfo` (System Events has no accessibility access here).

**Jump to a screen** with a deep link when the navigation itself isn't under test:

```bash
.claude/skills/verify/scripts/route.sh inventory      # also: recipes, profile, add-item, item/<uuid>
```

Prove navigation by tapping, not by deep link.

**Visible labels to aim for** are the app's own copy and accessibility labels, listed per feature in `features/`. The simulator tool has no accessibility tree, so find them in a screenshot and tap their center.

## Evidence

```bash
.claude/skills/verify/scripts/shot.sh <step-name>     # -> .verify/runs/<run>/NN-<step-name>.png
python3 -I .claude/skills/verify/scripts/db.py <table> "<postgrest query>"
```

Everything goes in `.verify/runs/<timestamp>-<run-name>/` (gitignored, kept after cleanup). `.verify/current` points at the active run. `api.log` and `metro.log` there hold server output when this run started the servers.

Proof standards:

- Drive the real user path: tap the buttons a user taps. Never call Supabase or the API directly to *cause* the change, and never use test-only setters.
- Capture before, the action, and after. A final screen alone isn't proof.
- Confirm side effects with `db.py`, filtered by `household_id`. For example, an added item shows in `inventory_items`, a saved recipe in `saved_recipes`, a cook in `cook_events`. `db.py` is GET-only but uses the backend secret key, which bypasses row-level security, so always filter.
- For API features, quote the matching `api.log` request lines (method, path, status).
- Save `db.py` output into the run directory (`> "$(readlink .verify/current)/<name>.json"`) so the proof survives the session.

## Cleanup

```bash
.claude/skills/verify/scripts/cleanup.sh
```

It stops only the API and Metro process groups that `launch.sh` started, and shuts down the simulator only if `launch.sh` booted it. It never deletes `.verify/runs/`. Remove any `verify-…` items the run created through the app's own delete flow before cleanup, and capture that too. Run cleanup after every failed attempt as well, so retries start clean.

## Feature map

`features/README.md` indexes the user-facing features with a recipe for each. Drive every entry point a feature lists. Proving one convenient path doesn't prove the others. Keep the map current with `/maintain-verification-skill` when screens change.

## Known traps

- **Supabase pauses.** The free-tier project pauses after about a week without traffic. The app then hangs on "Loading your fridge…" with a "Network request failed" toast, and the doctor reports Supabase unreachable. `supabase projects list -o json` shows `INACTIVE`. Only Brandon restores it, from the Supabase dashboard.
- **New dependencies after a pull.** Metro exits with `"<package>" is added as a dependency … but it doesn't seem to be installed`. Run `npm install` in `mobile/` (and `venv/bin/pip install -r requirements.txt` in `backend/` for Python changes), then cleanup and launch again.
- **LAN API URL.** `mobile/.env` points the app at the Mac's LAN IP. After a network change the doctor flags it. Fix the IP and restart Metro (cleanup, launch), because Expo inlines env values at bundle time.
- **Expo Go version.** Expo Go must stay on 54.x to match SDK 54. Other simulators on this Mac have Expo Go 57 and no signed-in session.
- **Code edits.** Metro hot-reloads JS edits. For changes to `.env`, `app.json` or native config, cleanup and launch again.
