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

export type RecipeInventoryContext = {
  id: string;
  name: string;
  quantity: number;
  unit: string;
  expiration_date: string | null;
};

export type RecipeSuggestionRequest = {
  inventory: RecipeInventoryContext[];
  preferences: RecipePreferences;
  exclude_titles: string[];
  batch_ceiling: number;
};

export type RecipeFeedSessionRequest = {
  inventory: RecipeInventoryContext[];
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

export type RecipeFeedResponse = {
  data: {
    session_id: string;
    recipes: RecipeSuggestion[];
    next_cursor: string | null;
    has_more: boolean;
    ready_count: number;
    empty_reason: string | null;
  };
};
