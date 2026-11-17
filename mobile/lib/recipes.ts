import type {
  RecipeFeedSessionRequest,
  RecipeIngredient,
  RecipePreferences,
  RecipeSuggestionRequest,
  RequestedDish,
} from "@/types/recipes";

/**
 * Returns whether a recipe ingredient is one of the household's kitchen basics,
 * such as salt. The backend gives an ingredient a null food id only when it is
 * a basic (`FoodLabels.resolve`), so cooking never deducts these.
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

const DEFAULT_MAIN_SUGGESTION = "a protein, pasta or rice";

// Keys are the "Any diet goals?" answers in RECIPE_PREFERENCE_STEPS.
const MAIN_SUGGESTION_BY_DIET: Readonly<Record<string, string>> = {
  Vegan: "beans, tofu, lentils or pasta",
  Vegetarian: "eggs, beans, tofu or pasta",
  Keto: "meat, fish, eggs or cheese",
  "Gluten-free": "a protein, rice or potatoes",
  "High protein": "chicken, fish, eggs, beans or tofu",
};

/**
 * Why a recipe feed ended: it still shows recipes, the cook dismissed every
 * card it loaded, or the kitchen couldn't make the dish the session asked for.
 */
export type RecipeFeedEnding =
  | { kind: "showing" }
  | { kind: "dismissed" }
  | { kind: "empty"; dish: RequestedDish };

/** The title and message at the end of a recipe feed. */
export type RecipeFeedEndingCopy = { title: string; message: string };

const FRESH_SET = "Add ingredients or edit your answers for a fresh set.";

const EMPTY_COPY: Readonly<
  Record<RequestedDish, (diet?: string) => RecipeFeedEndingCopy>
> = {
  meal: (diet) => {
    const main =
      (diet && MAIN_SUGGESTION_BY_DIET[diet]) || DEFAULT_MAIN_SUGGESTION;
    return {
      title: "Not enough for a full meal",
      message: `Add a main to build a meal around, such as ${main}, or change your answers.`,
    };
  },
  snack: () => ({
    title: "Not enough for a snack",
    message:
      "Add something to snack on, such as fruit, nuts or crackers, or change your answers.",
  }),
  dessert: () => ({
    title: "Not enough for a dessert",
    message:
      "Add something sweet to build a dessert around, such as fruit, chocolate or oats, or change your answers.",
  }),
};

/**
 * Returns the copy for the end of a recipe feed.
 *
 * An empty meal feed suggests a main that fits the diet answer.
 *
 * @param ending - Why the feed ended, from `useRecipeFeed`.
 * @param diet - The "Any diet goals?" answer, if any.
 */
export function recipeFeedEndingCopy(
  ending: RecipeFeedEnding,
  diet?: string,
): RecipeFeedEndingCopy {
  switch (ending.kind) {
    case "showing":
      return {
        title: "That's all for now",
        message: `You've explored this set of recipe ideas. ${FRESH_SET}`,
      };
    case "dismissed":
      return {
        title: "You've seen them all",
        message: `You've passed on every recipe in this set. ${FRESH_SET}`,
      };
    case "empty":
      return EMPTY_COPY[ending.dish](diet);
  }
}
