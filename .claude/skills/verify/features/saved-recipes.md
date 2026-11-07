# Saved recipes

Saved recipes is the household's shared cookbook. Any member can save a recipe card from the feed, and saved recipes show under the "Saved" segment of the Recipes tab, where they open the same preview and can be removed.

## Sub-features

- `saved-add` saves a card from the feed ("Save <title> to household cookbook").
- `saved-list` lists saved recipes under "Saved" ("Your household cookbook").
- `saved-open` opens a saved recipe's preview ("Open <title>").
- `saved-remove` removes it ("Remove <title> from saved recipes").
- `saved-empty` shows "Nothing saved yet".

## How to get to it (user POV)

- Tap the bookmark on a feed card.
- Recipes tab, then the "Saved" segment.

## Driving it with the iOS simulator

Preconditions:

- A feed with at least one card from [Recipe feed](./recipe-feed.md) in this run. Don't generate a new one just for this.
- Note what's saved first: `db.py saved_recipes "household_id=eq.<id>&select=recipe_id,title:recipe->>title"`. There's no `title` column: each row stores the whole recipe as a `recipe` JSON snapshot, and `recipe->>title` reads the title out of it.

- **Save.** On a feed card, tap the bookmark. Its label flips to "Saved". `shot.sh saved-toggle`.
- **Stored row.** The same `db.py saved_recipes` query now includes the card's title.
- **List.** Tap the "Saved" segment. The recipe is listed. `shot.sh saved-list`.
- **Open.** Tap the saved recipe. Its preview opens with the same ingredients. `shot.sh saved-open`.
- **Remove.** Tap the filled bookmark on the saved row. The row disappears, or "Nothing saved yet" shows, and `db.py` no longer returns it. `shot.sh saved-removed`.

## Gotchas

- Saved recipes are household-wide, so rows saved by another member show too. Assert on the title you saved, not on the count.
- "Couldn't update saved recipes" is the network error toast. Run the doctor.
- Remove what this run saved, so Brandon's real cookbook is unchanged.
