import type { RecipeFeedSteering, RecipeSuggestion } from "@/types/recipes";

/** Which feedback button the cook pressed on a feed card. */
export type SteerDirection = "more" | "less";

/** One "More like this" or "Less like this" press. */
export type SteerSignal = {
  direction: SteerDirection;
  recipe: RecipeSuggestion;
};

// A share of every food the two recipes use between them. Oil, garlic and
// other staples appear in almost every recipe, so a fixed count of shared
// foods would call nearly any two recipes alike.
const SIMILAR_SHARE = 0.5;
// Without a floor, two one-food recipes that share it would be 100% alike.
const MIN_SHARED_FOODS = 2;
// Mirror the backend's limits on `RecipeFeedSteering`.
const MAX_STEERING_MORE_LIKE = 3;
const MAX_STEERING_LESS_LIKE = 10;

// Kitchen basics, the ingredients with no inventory id, season nearly every
// recipe, so they say nothing about likeness. Mirrors `_examples` in
// backend/app/services/recipe_steering.py.
function recipeFoods(recipe: RecipeSuggestion): Set<string> {
  return new Set(
    recipe.ingredients.flatMap((ingredient) =>
      ingredient.inventory_item_id === null
        ? []
        : [ingredient.inventory_item_id],
    ),
  );
}

/**
 * Returns whether two recipes are alike: they share at least two foods, and
 * the shared foods are at least half of all the foods the two use between
 * them. Foods match by inventory id, and kitchen basics don't count.
 */
export function areRecipesSimilar(
  a: RecipeSuggestion,
  b: RecipeSuggestion,
): boolean {
  const foodsA = recipeFoods(a);
  const foodsB = recipeFoods(b);
  let shared = 0;
  for (const food of foodsA) if (foodsB.has(food)) shared += 1;
  const total = foodsA.size + foodsB.size - shared;
  return shared >= MIN_SHARED_FOODS && shared / total >= SIMILAR_SHARE;
}

/**
 * Returns the ids of the cards a "More like this" or "Less like this" press
 * removes, in feed order. Only the chosen card and the cards below it can
 * leave; the cards above never move.
 *
 * - `more` removes the cards below that aren't alike to the chosen one, so the
 *   alike ones close up under it.
 * - `less` removes the chosen card and the cards below that are alike to it.
 *
 * @param recipes - The feed's cards, top to bottom.
 * @param recipeId - The card whose button was pressed. Sweeps nothing when it
 *   is no longer in `recipes`.
 */
export function planSteerSweep(
  recipes: readonly RecipeSuggestion[],
  recipeId: string,
  direction: SteerDirection,
): string[] {
  const index = recipes.findIndex((recipe) => recipe.recipe_id === recipeId);
  if (index === -1) return [];
  const chosen = recipes[index];
  const below = recipes
    .slice(index + 1)
    .filter(
      (recipe) => areRecipesSimilar(chosen, recipe) === (direction === "less"),
    )
    .map((recipe) => recipe.recipe_id);
  return direction === "less" ? [recipeId, ...below] : below;
}

/**
 * Returns the session's picks as a page request's `steering` field, most
 * recent last and cut to the backend's limits, or `undefined` before the
 * first pick.
 *
 * @param signals - The session's picks, oldest first.
 */
export function steeringRequest(
  signals: readonly SteerSignal[],
): RecipeFeedSteering | undefined {
  if (signals.length === 0) return undefined;
  const ids = (direction: SteerDirection) =>
    signals
      .filter((signal) => signal.direction === direction)
      .map((signal) => signal.recipe.recipe_id);
  return {
    more_like: ids("more").slice(-MAX_STEERING_MORE_LIKE),
    less_like: ids("less").slice(-MAX_STEERING_LESS_LIKE),
  };
}

/**
 * Returns the arriving cards the cook's picks still allow, in order.
 *
 * Generation is only asked to follow the picks, so this enforces them. A
 * card goes when the latest pick it is alike to is "Less like this", so a
 * later "More like this" on an alike recipe overrides an earlier "Less like
 * this". When "More like this" was pressed after the page was requested,
 * only cards alike to that pick stay, as if its sweep had run over them.
 *
 * @param signals - The session's picks now, oldest first.
 * @param requested - The `signals` array as it was when the page was
 *   requested. Picks not in it came after the request.
 */
export function keepSteeredCards<T extends RecipeSuggestion>(
  cards: readonly T[],
  signals: readonly SteerSignal[],
  requested: readonly SteerSignal[],
): T[] {
  if (signals.length === 0) return [...cards];
  const lateMoreLike = signals
    .filter(
      (signal) => signal.direction === "more" && !requested.includes(signal),
    )
    .at(-1)?.recipe;
  return cards.filter((card) => {
    const latestAlike = signals.findLast((signal) =>
      areRecipesSimilar(signal.recipe, card),
    );
    return (
      latestAlike?.direction !== "less" &&
      (lateMoreLike === undefined || areRecipesSimilar(lateMoreLike, card))
    );
  });
}
