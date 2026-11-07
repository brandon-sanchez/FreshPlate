# FreshPlate verification map

This directory is the maintained source for verifying FreshPlate's user-facing behavior. Read this index before driving the app, then use the matching feature file as the recipe. Commands and conventions come from `../SKILL.md`.

## Baseline preconditions

- `launch.sh <run-name>` succeeded and `00-launch.png` shows the loaded Home screen.
- `doctor.sh` exits 0.
- Find the household once per run: `python3 -I .claude/skills/verify/scripts/db.py household_members "user_id=eq.<user id from doctor>&select=household_id"`. Every later `db.py` query filters by it.
- The household has a few inventory items. If it's empty, add them through the app (see [Add an item](./add-item.md)), never by writing to the database.

## Driving conventions

- Start each recipe from the Home tab unless its preconditions say otherwise.
- Find buttons by their visible copy or accessibility label in a screenshot, then tap the center in device points (screenshot pixel ÷ 3).
- Name every test item `verify-<feature>-<short-id>` so cleanup can find it and Brandon's real items are never touched.
- Take a `shot.sh` before and after every step that changes something.

## Proof and skip reporting

- Proof is the action screenshot, the result screenshot, and a `db.py` read of the stored row, saved into the run directory.
- AI features also quote the API request lines from `api.log`.
- Record which entry point each artifact proves. A skipped entry point is reported as skipped, with the unmet precondition, never as covered by another path.
- Delete `verify-…` data through the app before `cleanup.sh`, and capture that deletion too.

## Feature entry contract

Each feature file starts with an H1 title and one paragraph describing the user-visible behavior, then four H2 sections in this order: `Sub-features`, `How to get to it (user POV)`, `Driving it with the iOS simulator`, `Gotchas`.

## Features

- [Inventory](./inventory.md) covers the fridge list, search, filters, item detail, edit and delete.
- [Add an item](./add-item.md) covers manual entry, validation and merging into an existing item.
- [Recipe feed](./recipe-feed.md) covers generating recipes from the fridge, the question flow, the carousel, preview and full recipe view.
- [Saved recipes](./saved-recipes.md) covers saving from the feed and the household cookbook tab.

## Not yet reachable

- **Cooking** (#27 cook entry, #30–#32): `main` has the active-cook store and the `POST /api/cook/confirm` API, but no screen a user can start cooking from. Add a feature file when the entry button ships.
- **Barcode scan**: the Scan tab needs a camera, and the simulator has none. Verify the lookup through the scan-review screen only when a ticket needs it, and say the camera step went unverified.
