import type { RecipeStep } from "@/types/recipes";

const optionalText = (value: unknown): boolean =>
  value === undefined || value === null || typeof value === "string";

const optionalWholeNumber = (value: unknown): boolean =>
  value === undefined ||
  value === null ||
  (typeof value === "number" && Number.isFinite(value));

const stringList = (value: unknown): boolean =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

/**
 * Returns whether `value` is a usable recipe step in either saved shape: a
 * non-blank string, or an object with a non-blank `instruction`.
 */
export function isRecipeStep(value: unknown): value is RecipeStep | string {
  if (typeof value === "string") return value.trim().length > 0;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const step = value as Record<string, unknown>;
  return (
    typeof step.instruction === "string" &&
    step.instruction.trim().length > 0 &&
    optionalText(step.doneness_cue) &&
    optionalText(step.why) &&
    optionalWholeNumber(step.minutes) &&
    (step.uses === undefined || stringList(step.uses))
  );
}

/**
 * Returns whether a stored recipe's cookbook fields have the types the app
 * reads: text or `null` for the headnote and for each ingredient's `prep`
 * and `display_amount`, numbers or `null` for the times, and a list of text
 * for the equipment. Each field may also be missing.
 */
export function hasReadableCookbookFields(
  recipe: Record<string, unknown>,
): boolean {
  return (
    optionalText(recipe.headnote) &&
    optionalWholeNumber(recipe.active_minutes) &&
    optionalWholeNumber(recipe.total_minutes) &&
    (recipe.equipment === undefined || stringList(recipe.equipment)) &&
    Array.isArray(recipe.ingredients) &&
    recipe.ingredients.every(
      (item) =>
        !!item &&
        typeof item === "object" &&
        optionalText((item as Record<string, unknown>).prep) &&
        optionalText((item as Record<string, unknown>).display_amount),
    )
  );
}
