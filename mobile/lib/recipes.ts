import type {
  RecipeFeedSessionRequest,
  RecipeIngredient,
  RecipePreferences,
  RecipeSuggestionRequest,
} from "@/types/recipes";

/**
 * Returns whether a recipe ingredient is one of the household's kitchen basics,
 * such as salt. The backend's response schema (`recipe_batch_model`) allows a
 * null food id only for a basic, so cooking never deducts these.
 */
export function isKitchenBasic(ingredient: RecipeIngredient): boolean {
  return ingredient.inventory_item_id === null;
}

export function countAnsweredPreferences(
  preferences: RecipePreferences,
): number {
  return Object.values(preferences).filter(
    (value) => typeof value === "string" && value.trim().length > 0,
  ).length;
}

export function recipeContextLabel(
  itemCount: number,
  preferences: RecipePreferences,
): string {
  const answered = countAnsweredPreferences(preferences);
  if (answered === 0) return `From your ${itemCount} items`;
  return `Tuned · ${answered} preference${answered === 1 ? "" : "s"}`;
}

/** Returns the request body that asks for one batch of recipe suggestions. */
export function buildRecipeSuggestionRequest(
  householdId: string,
  preferences: RecipePreferences,
): RecipeSuggestionRequest {
  return {
    household_id: householdId,
    preferences,
    exclude_titles: [],
    batch_ceiling: 8,
  };
}

/** Returns the request body that starts a recipe feed for the household. */
export function buildRecipeFeedSessionRequest(
  householdId: string,
  preferences: RecipePreferences,
): RecipeFeedSessionRequest {
  return { household_id: householdId, preferences };
}
