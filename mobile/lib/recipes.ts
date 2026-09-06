import type { InventoryItem } from "@/hooks/useInventoryItems";
import type {
  RecipeInventoryContext,
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

export function toRecipeInventoryContext(
  items: InventoryItem[],
): RecipeInventoryContext[] {
  return items.map((item) => ({
    id: item.id,
    name: item.name,
    quantity: item.quantity,
    unit: item.unit,
    expiration_date: item.expiration_date,
  }));
}

export function buildRecipeSuggestionRequest(
  items: InventoryItem[],
  preferences: RecipePreferences,
): RecipeSuggestionRequest {
  return {
    inventory: toRecipeInventoryContext(items),
    preferences,
    exclude_titles: [],
    batch_ceiling: 8,
  };
}

export function buildRecipeFeedSessionRequest(
  items: InventoryItem[],
  preferences: RecipePreferences,
): RecipeFeedSessionRequest {
  return {
    inventory: toRecipeInventoryContext(items),
    preferences,
  };
}
