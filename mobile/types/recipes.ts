import type { ImageResult } from "@/types/images";

export const RECIPE_PREFERENCE_KEYS = [
  "meal",
  "time",
  "mood",
  "cuisine",
  "diet",
  "occasion",
] as const;

export type RecipePreferenceKey = (typeof RECIPE_PREFERENCE_KEYS)[number];

export type RecipePreferences = Partial<
  Record<RecipePreferenceKey, string>
>;

/**
 * Body of `POST /api/recipes/suggestions`. The backend reads
 * `household_id`'s foods itself, so the request carries no inventory.
 */
export type RecipeSuggestionRequest = {
  household_id: string;
  preferences: RecipePreferences;
  exclude_titles: string[];
  batch_ceiling: number;
};

/**
 * Body of `POST /api/recipes/sessions`. The backend reads `household_id`'s
 * foods itself, so the request carries no inventory.
 */
export type RecipeFeedSessionRequest = {
  household_id: string;
  preferences: RecipePreferences;
};

export type RecipeIngredient = {
  name: string;
  inventory_item_id: string | null;
  use_amount: number;
  unit: string;
};

export type RecipeSuggestion = {
  recipe_id: string;
  title: string;
  cook_time_minutes: number;
  servings: number;
  ingredients: RecipeIngredient[];
  steps: string[];
  match_percent: number;
  saves_expiring: string[];
};

export type RecipeSuggestionsResponse = {
  data: {
    recipes: RecipeSuggestion[];
  };
};

/**
 * The `steering` field of `POST /api/recipes/sessions/{id}/pages`: the
 * session's "More like this" and "Less like this" picks, most recent last.
 * The backend accepts at most 3 and 10 ids.
 */
export type RecipeFeedSteering = {
  more_like: string[];
  less_like: string[];
};

/** A recipe as the feed endpoints serve it, with its photo. */
export type RecipeFeedCard = RecipeSuggestion & {
  /**
   * The recipe's photo or placeholder result, generated with the batch.
   * `null` when a page read from the stored pool found no stored photo; the
   * photo is then requested from `POST /api/images/recipes/{recipe_id}`.
   */
  image: ImageResult | null;
};

/** Body of a feed session or page response. */
export type RecipeFeedResponse = {
  data: {
    session_id: string;
    recipes: RecipeFeedCard[];
    next_cursor: string | null;
    has_more: boolean;
    ready_count: number;
    empty_reason: string | null;
  };
};
