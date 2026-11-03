# Add an item

Add item lets the user put food into inventory by typing it in. The user picks a category and storage, the app suggests an expiry from them, saving is blocked until there's a name, and adding something that already exists merges into that item.

## Sub-features

- `add-manual` saves a new item from the Manual tab and lands on Inventory with an "Added <name>" toast.
- `add-validate` keeps "Add to inventory" disabled (pale green) while the name is empty.
- `add-shelf-life` fills "Expires in" from the category and storage, with a hint like "≈ Nov 4 · USDA average for Produce in fridge".
- `add-merge` adds to an existing item instead of creating a duplicate ("Added to your existing item.").

## How to get to it (user POV)

- Tap the raised green Add item button in the tab bar.
- Home and Inventory empty states have an "Add items" button.

## Driving it with the iOS simulator

Preconditions:

- Baseline preconditions from the index.
- No item named `verify-add-<id>` exists.

Points measured on 2026-10-28 are in brackets. Re-measure if a screenshot shows a different layout.

- **Open form.** Tap the Add item tab [220, 872]. "Add Item" shows with the Manual segment selected and "Add to inventory" disabled. `shot.sh add-open`.
- **Fill.** Tap the "What are you adding?" field [220, 221] and type `verify-add-<id>`. Tap a category chip, e.g. "Produce" [55, 300]. Quantity defaults to 1 and unit to "item". Storage defaults to Fridge. "Expires in" shows a day count and the USDA hint. `shot.sh add-filled`.
- **Save.** Tap "Add to inventory" [220, 736]. The app switches to Inventory, the header count goes up by one, and an "Added <name>" toast with "Tap to view in your inventory." shows. `shot.sh add-saved`.
- **Stored row.** `db.py inventory_items "household_id=eq.<id>&name=ilike.verify-add-<id>&select=id,name,quantity,unit,storage_location,expiration_date"` returns one row matching the form. Match the full name, so a leftover item from an earlier failed run can't be mistaken for this one. Save it into the run directory.
- **Second view.** Home's "In fridge" count shows the new total.
- **Merge.** Add the same name, unit and storage again. The toast says "Added to your existing item.", and `db.py` still returns one row with the summed quantity.
- **Clean up.** Remove the item as in [Inventory](./inventory.md). `db.py` returns `[]`.

## Gotchas

- iOS capitalizes the first letter, so `verify-add-1028` is stored as `Verify-add-1028`. Query with `ilike`, never `eq`.
- The Photo tab is hidden for MVP. Only Manual and Scan show.
- The Scan tab opens the camera. The simulator has no camera, so stay on Manual.
- A network failure shows "Couldn't save" / "Check your connection and try again." Run the doctor before blaming the form.
