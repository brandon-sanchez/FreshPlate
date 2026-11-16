import { MEASURED_UNITS } from "@/lib/stockUnit";
import type {
  RecipeIngredient,
  RecipeStep,
  RecipeSuggestion,
} from "@/types/recipes";

// Cooks write "2 cups" but "2 tbsp", so cup is the one measured unit that
// takes a plural.
const ABBREVIATED_UNITS = new Set(
  [...MEASURED_UNITS].filter((unit) => unit !== "cup"),
);
const SMALLEST_FRACTION = "⅛";
const WHOLE_NUMBER_UNITS = new Set(["g", "mg", "ml"]);
const FRACTIONS: [number, string][] = [
  [0, ""],
  [1 / 8, SMALLEST_FRACTION],
  [1 / 4, "¼"],
  [1 / 3, "⅓"],
  [1 / 2, "½"],
  [2 / 3, "⅔"],
  [3 / 4, "¾"],
  [1, ""],
];
// Mirrors _COPIED_STEP_PREFIX in backend/app/ai/agents/nodes.py, which
// tidies generated recipes. This copy tidies string-step recipes.
const COPIED_STEP_PREFIX = /^\s*(?:step\s*\d+\s*[:.)\-–—]?|\d+\s*[:.)])\s*/i;

function pluralize(word: string): string {
  if (/[^s]s$/.test(word)) return word;
  if (/(s|x|z|ch|sh)$/.test(word)) return word + "es";
  if (/[^aeiou]y$/.test(word)) return word.slice(0, -1) + "ies";
  if (word === "leaf" || word === "loaf") return word.slice(0, -1) + "ves";
  return word + "s";
}

function amountText(amount: number, unit: string): string {
  if (WHOLE_NUMBER_UNITS.has(unit) && amount >= 1) return String(Math.round(amount));
  const whole = Math.floor(amount);
  const [fraction, glyph] = FRACTIONS.reduce((best, candidate) =>
    Math.abs(candidate[0] - (amount - whole)) <
    Math.abs(best[0] - (amount - whole))
      ? candidate
      : best,
  );
  const count = fraction === 1 ? whole + 1 : whole;
  if (count === 0 && !glyph) return SMALLEST_FRACTION;
  return (count > 0 ? String(count) : "") + glyph;
}

function namesUnit(name: string, unit: string): boolean {
  const escaped = unit.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escaped}(e?s)?\\b`, "i").test(name);
}

/**
 * Returns an ingredient's amount as a cook says it, without its name.
 *
 * Uses the recipe's `display_amount` when it has one. Otherwise formats `use_amount` and `unit`: fractions instead of decimals
 * ("¼ head"), whole grams and millilitres ("30 ml"), plural units
 * ("3 cloves"), and no unit when it is "each" or the name already says it,
 * so "Salmon fillets" reads "2", not "2 fillet".
 */
export function formatIngredientAmount(ingredient: RecipeIngredient): string {
  const spoken = ingredient.display_amount?.trim();
  if (spoken) return spoken;
  const unit = ingredient.unit.trim().toLowerCase();
  const amount = amountText(ingredient.use_amount, unit);
  if (unit === "each" || namesUnit(ingredient.name, unit)) return amount;
  const plural =
    ingredient.use_amount > 1 && !ABBREVIATED_UNITS.has(unit) && amount !== "1";
  return `${amount} ${plural ? pluralize(unit) : unit}`;
}

/**
 * Returns a recipe's steps as structured steps, whichever shape it was saved in.
 *
 * A plain string step becomes a step holding only its instruction, with any
 * copied "Step 1:" or "1." prefix removed.
 */
export function readRecipeSteps(
  steps: RecipeSuggestion["steps"],
): RecipeStep[] {
  return steps.map((step) =>
    typeof step === "string"
      ? { instruction: step.replace(COPIED_STEP_PREFIX, "").trim() || step.trim(), uses: [] }
      : step,
  );
}
