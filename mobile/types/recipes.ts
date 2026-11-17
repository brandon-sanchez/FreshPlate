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

/** One recipe ingredient and the food it draws on. */
export type RecipeIngredient = {
  /** The ingredient as the cook calls it, such as "Garlic". */
  name: string;
  /**
   * The food the ingredient draws on, or `null` for a kitchen basic such as
   * salt, which is always on hand and never deducted.
   */
  inventory_item_id: string | null;
  /** The amount in `unit`, which the cook flow deducts from the food. */
  use_amount: number;
  /** The unit of `use_amount`, such as "clove" or "ml". */
  unit: string;
  /**
   * How to prepare the ingredient, such as "minced". Missing or `null` when
   * it needs nothing, and on string-step recipes.
   */
  prep?: string | null;
  /**
   * The amount as a cook says it, without the name, such as "3 cloves".
   * Missing or `null` on string-step recipes. Read it
   * through `formatIngredientAmount` in `lib/recipe-format`, which falls
   * back to `use_amount`.
   */
  display_amount?: string | null;
};

/**
 * One stage of a recipe's method. Steps are flat and numbered in cooking
 * order; `phase` labels a step without grouping it.
 */
export type RecipeStep = {
  /**
   * The meal component the stage works on, such as "Rice" or "Finish".
   * Missing or `null` for a dish with one component, and on string-step
   * recipes.
   */
  phase?: string | null;
  /** A short action heading, a newline, then one to three sentences. */
  instruction: string;
  /** What the cook sees, smells or tests when the stage is done, or `null`. */
  doneness_cue?: string | null;
  /** About how long the stage takes, in minutes, or `null` when untimed. */
  minutes?: number | null;
  /** A few words on why the stage matters, or `null`. */
  why?: string | null;
  /** The `inventory_item_id` of each ingredient the stage uses. */
  uses?: string[];
};

/** A generated recipe as the feed, saved recipes and the cook flow carry it. */
export type RecipeSuggestion = {
  recipe_id: string;
  title: string;
  /** One or two sentences on the dish. Missing on string-step recipes. */
  headnote?: string | null;
  /** Minutes from start to plate. */
  cook_time_minutes: number;
  servings: number;
  /** Hands-on minutes. Missing on string-step recipes. */
  active_minutes?: number | null;
  /** Minutes from start to plate, rests included. Missing on string-step recipes. */
  total_minutes?: number | null;
  /** The pans and tools the method needs. Missing on string-step recipes. */
  equipment?: string[];
  /** The ingredients, in the order the method first uses them. */
  ingredients: RecipeIngredient[];
  /**
   * The method, as structured steps or, in a string-step recipe, plain
   * strings. Read it through `readRecipeSteps` in `lib/recipe-format`.
   */
  steps: (RecipeStep | string)[];
  match_percent: number;
  saves_expiring: string[];
};

export type RecipeSuggestionsResponse = {
  data: {
    recipes: RecipeSuggestion[];
  };
};

/**
 * The kind of dish a feed session asks for. The backend decides it from the
 * session's answers: a meal unless the cook asks for a snack or a dessert.
 */
export type RequestedDish = "meal" | "snack" | "dessert";

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
    requested_dish: RequestedDish;
  };
};
