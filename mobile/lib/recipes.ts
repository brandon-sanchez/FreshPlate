import type {
  RecipeFeedSessionRequest,
  RecipePreferences,
  RecipeSuggestionRequest,
} from "@/types/recipes";

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
