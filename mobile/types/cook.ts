import type { RecipeIngredient } from "@/types/recipes";

/** A food's stock unit family: grams, millilitres or a count. */
export type StockBase = "g" | "ml" | "each";

/** How a recipe ingredient converted into its food's stock base. */
export type CookLineMode = "draw" | "small" | "ask";

/** One recipe ingredient on a food, as `POST /api/cook/plan` returns it. */
export type CookPlanLine = {
  /** The ingredient's index in the recipe's ingredients. */
  line: number;
  /** The ingredient's name. */
  ingredient: string;
  /** The recipe's amount, 0 when the recipe gave none. */
  recipe_amount: number;
  /** The recipe's unit, such as "tbsp". */
  recipe_unit: string;
  /**
   * `draw` when the amount converted, `small` for a seasoning-sized amount
   * that is never drawn, or `ask` when the checklist asks how much was used.
   */
  mode: CookLineMode;
  /** For `draw`, the amount in the food's stock base; `null` otherwise. */
  stock_amount: number | null;
};

/** One food the recipe uses, with its stock and the amount to pre-fill. */
export type CookPlanFood = {
  food_id: string;
  name: string;
  stock_base: StockBase;
  /** The counted unit, such as "egg"; `null` unless `stock_base` is "each". */
  each_label: string | null;
  /** True for counted foods that can't be split, such as eggs. */
  whole_units_only: boolean;
  /** Unexpired stock in the food's stock base when the plan was made. */
  available: number;
  /** The amount the recipe takes, rounded up for whole-unit foods. */
  draw: number;
  /** True when a profile estimate went into `draw`. */
  estimated: boolean;
  /** Set when `draw` was rounded up, such as "Uses 2 eggs, recipe needs about 1.5". */
  rounding_note: string | null;
  /** The ingredients on this food, in recipe order. */
  lines: CookPlanLine[];
};

/** An ingredient the cook takes nothing from stock for. */
export type UntrackedIngredient = {
  line: number;
  name: string;
  /** `basic` for a kitchen basic, `not_in_kitchen` for a food with no stock left. */
  reason: "basic" | "not_in_kitchen";
};

/** Data of `POST /api/cook/plan`: the done-cooking checklist for one recipe. */
export type CookPlan = {
  foods: CookPlanFood[];
  untracked: UntrackedIngredient[];
};

/** Body of `POST /api/cook/plan`. */
export type CookPlanRequest = {
  household_id: string;
  ingredients: RecipeIngredient[];
};

/** One food a confirmed cook used, in the food's stock base. */
export type CookDeduction = {
  inventory_item_id: string;
  confirmed_amount: number;
  /** How much of `confirmed_amount` the checklist expected stock to cover. */
  expected_amount: number;
};

/** One recipe ingredient as cooked, recorded on the cook event. */
export type CookIngredientLine = {
  ingredient: string;
  inventory_item_id: string;
  recipe_amount: number;
  recipe_unit: string;
  mode: CookLineMode;
  stock_amount: number | null;
};

/** Body of `POST /api/cook/confirm`. */
export type CookConfirmationRequest = {
  household_id: string;
  operation_id: string;
  recipe_id: string;
  recipe_snapshot: Record<string, unknown>;
  deductions: CookDeduction[];
  lines: CookIngredientLine[];
};
