# Recipe feed

The Recipes tab generates recipe ideas grounded in what's in the household's kitchen. The user can generate straight from the fridge, add a short context, or answer a few questions first. Recipes appear as a vertical carousel of cards that refills as the user nears the end, and each card opens a preview and then the full recipe.

## Sub-features

- `feed-generate` makes a first batch from "Generate from my fridge".
- `feed-context` generates with typed context ("Occasion or recipe context").
- `feed-questions` goes through "Ask me questions first" (meal, cuisine vibe, diet goals, anything else) and then generates.
- `feed-carousel` moves between cards with swipes or "Next recipe" and "Previous recipe", and refills ("Finding more recipes").
- `feed-not-this` removes a card with "Not this".
- `feed-preview` opens the ingredients preview from a card.
- `feed-detail` opens the full recipe ("View full recipe") with steps.
- `feed-empty` shows "Add some items to your inventory first" when the kitchen is empty.
- `feed-error` shows "We couldn't generate recipes" with "Try again".

## How to get to it (user POV)

- Tap the Recipes tab, then the "For you" segment.
- Type in Home's "What do you want to cook?" card and send, or tap a suggestion chip ("Something quick with chicken", "Use what's expiring", "Low effort dinner").
- Tap "Ask me instead" on Home.

## Driving it with the iOS simulator

Preconditions:

- Baseline preconditions from the index, with at least 5 inventory items so meals are possible.
- Know where the API log is, so the requests can be quoted. If `launch.sh` started the API, it's `api.log` in the run directory. If it reused one an earlier verify run started, `launch.sh` printed that run's log path. If it reused Brandon's server, the log is in his terminal: ask him for the lines, or cleanup and launch again so this run owns the API.
- One generation per run. Each one costs Gemini calls.

- **Open.** Tap the Recipes tab. "Let's find something to cook" with "Generate from my fridge" and "Ask me questions first" shows. `shot.sh feed-start`.
- **Generate.** Tap "Generate from my fridge". The loader ("Generating recipes") shows, then the first card. Usually 8–15 s, and the budget is 30 s. `shot.sh feed-loading`, then `shot.sh feed-first-card`.
- **API proof.** `grep -E 'POST /api/recipes/sessions' <api log>` (the log found in the preconditions) shows `POST /api/recipes/sessions` (and `/sessions/<id>/pages` on refill) with `200`.
- **Grounding.** Every ingredient on the card's preview is in the inventory (compare with `db.py inventory_items "household_id=eq.<id>&select=name"`). Pantry staples are the only exception.
- **Carousel.** Swipe up on the card (start mid-screen) or tap "Next recipe". The next card centers. `shot.sh feed-next`.
- **Preview and detail.** Tap the card ("Open <title>"), then "View full recipe". Steps render with timing and doneness cues. `shot.sh feed-detail`. Close with "Close recipe details".
- **Home entry.** From Home, tap "Use what's expiring". The Recipes tab opens and generates with that context. Prove it with a second `POST /api/recipes/sessions` line only if this entry point is the one under test.

## Gotchas

- "Loading your fridge..." on this tab is the inventory query, not generation. If it hangs, Supabase is down (doctor).
- `RECIPE_FEED_UNAVAILABLE` in `api.log` means the backend is missing `SUPABASE_SECRET_KEY`.
- Refill happens near the end of the set ("Finding more recipes"). Swiping fast to the end triggers a second paid generation.
- Recipe photos come from the image cache and budget. A card with no photo is expected once the monthly image budget is spent.
