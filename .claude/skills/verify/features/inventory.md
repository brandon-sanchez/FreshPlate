# Inventory

Inventory shows everything in the household's fridge, freezer and pantry with an expiry urgency bar, lets the user search and filter it, and opens an item to edit or delete it.

## Sub-features

- `inv-list` lists items with name, quantity, storage and urgency, under a "<N> items · <M> expired" header.
- `inv-group` regroups the list with the "Group by" segments: Urgency, Location, Category.
- `inv-search` narrows the list with the "Search your fridge" bar at the top [~190, 158]. It's hidden behind the "Added …" or "Removed" toast while that shows.
- `inv-filter` opens the filter sheet with the funnel button right of the search bar [~402, 158]. It offers "Expiring this week" and "Leftovers only" (the sheet hasn't been driven in a proof run yet).
- `inv-detail` opens an item, edits it and saves.
- `inv-delete` removes an item after a "Remove item?" confirmation.
- `inv-empty` shows "Your fridge is empty" or "Nothing here yet".

## How to get to it (user POV)

- Tap the Inventory tab [138, 872].
- Tap an item on Home.
- After adding an item, tap the "Added <name>" toast. That scrolls the list to the item. It doesn't open it.

## Driving it with the iOS simulator

Preconditions:

- Baseline preconditions from the index.
- A `verify-inv-…` item exists (create it with [Add an item](./add-item.md)).

- **Open list.** Tap the Inventory tab. Header "Inventory" and the item rows appear, not "Loading your fridge…". `shot.sh inventory-list`.
- **Search.** Tap "Search your fridge", type `verify-inv`. Only the test item remains. `shot.sh inventory-search`.
- **Filter.** Clear the search, open the filter control, choose "Expiring this week". Only items expiring within 7 days remain. `shot.sh inventory-filter`.
- **Open detail.** Tap the test item's row, scrolled above the tab bar first. To reach it without testing navigation, `route.sh item/<id>` with the id from `db.py`. The screen has a "< Inventory" back button, the name, a quantity stepper (− / +), unit, an "Expires in" slider, storage segments, notes, and "Remove" and "Save" buttons at the bottom. `shot.sh item-detail`.
- **Edit.** Tap + on the quantity, then "Save". Back in the list the row shows the new quantity. Prove it with `db.py inventory_items "household_id=eq.<id>&name=ilike.verify-inv*&select=name,quantity,unit,expiration_date"`.
- **Delete.** Tap "Remove" [116, 902]. A "Remove item?" dialog says "<name> will be removed from your fridge." Tap its "Remove" [294, 538]. The app returns to Inventory with a "Removed" toast, the header count drops by one, and the same `db.py` query returns `[]`. `shot.sh removed`.

## Gotchas

- Urgency is computed from `expiration_date` relative to today, so the same item can move between "Use this week" and "Expired" across days.
- Home's three counts ("In fridge", "Use this week", "Expired") come from the same query. Check them after any change to the list.
- "Item not found" on the detail screen means the id is stale (the item was deleted or merged).
- The glass tab bar covers everything below about y = 820 pt, even where rows show through it. A tap there hits the tab bar (often Home), so scroll the row higher first.
- Brandon's real household has many expired items, so a new item lands at the bottom under "FRESH" and is off screen.
