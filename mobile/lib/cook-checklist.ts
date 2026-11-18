import { formatAmount, type SubUnit } from "@/lib/amount";
import { foodNameKey } from "@/lib/foodName";
import { roundAmount } from "@/lib/stockUnit";
import type { ActiveCook } from "@/stores/activeCook";
import type {
  CookConfirmationRequest,
  CookIngredientLine,
  CookPlan,
  CookPlanLine,
  StockBase,
} from "@/types/cook";

/**
 * One food on the done-cooking checklist. Amounts are in the food's stock
 * base: grams, millilitres or a count of `unit`.
 */
export type ChecklistLine = {
  foodId: string;
  name: string;
  /** Whether the food is weighed, measured by volume or counted. */
  stockBase: StockBase;
  /** The word amounts are counted in: "g", "ml", or a count word such as "egg". */
  unit: string;
  /** True for counted foods that can't be split, so the stepper moves by 1. */
  wholeUnitsOnly: boolean;
  /** The counted food's smaller unit, such as a clove of garlic, or `null`. */
  subUnit: SubUnit | null;
  /** Unexpired stock the person was last shown. */
  available: number;
  /** How much the person says they used. 0 deducts nothing. */
  amount: number;
  /** True when a profile estimate went into the pre-filled amount. */
  estimated: boolean;
  /** Why the pre-filled amount was rounded up, or `null`. */
  roundingNote: string | null;
  /**
   * The recipe ingredients on this food, from the plan. Empty for a food
   * added with "Add item".
   */
  planLines: CookPlanLine[];
  /** Says how stock changed since the person last saw it, such as "Only 2 eggs left now". */
  changed: string | null;
};

/** What "Add item" needs to know about a food to put it on the checklist. */
export type AddableFood = Pick<
  ChecklistLine,
  "foodId" | "name" | "stockBase" | "unit" | "available" | "wholeUnitsOnly" | "subUnit"
>;

const ADD_ITEM_LIMIT = 5;
const MEASURED_STEPS: [below: number, step: number][] = [
  [100, 5],
  [1000, 25],
  [Infinity, 100],
];
const SPLIT_COUNT_STEP = 0.25;

/** Returns one checklist line per planned food, pre-filled with the amount the recipe takes. */
export function linesFromPlan(plan: CookPlan): ChecklistLine[] {
  return plan.foods.map((food) => ({
    foodId: food.food_id,
    name: food.name,
    stockBase: food.stock_base,
    unit: food.each_label ?? food.stock_base,
    wholeUnitsOnly: food.whole_units_only,
    subUnit: null,
    available: food.available,
    amount: food.draw,
    estimated: food.estimated,
    roundingNote: food.rounding_note,
    planLines: food.lines,
    changed: null,
  }));
}

/** Returns a checklist line for a food the recipe didn't list, starting at one step. */
export function addedLine(food: AddableFood): ChecklistLine {
  const line: ChecklistLine = {
    ...food,
    amount: 0,
    estimated: false,
    roundingNote: null,
    planLines: [],
    changed: null,
  };
  return { ...line, amount: stepAmount(line, 1) };
}

/**
 * Returns the line's amount one step up or down, snapped to the step: whole
 * units step by 1, other counts by one of their smaller unit or else by a
 * quarter, and weights and volumes by 5, 25 or 100 depending on the amount.
 * Never below 0.
 *
 * @param direction - 1 for up, -1 for down.
 */
export function stepAmount(line: ChecklistLine, direction: 1 | -1): number {
  const size = stepSize(line);
  // A sub-unit step such as 0.1 is inexact in binary, so 0.3 / 0.1 lands
  // just under 3 and would step back to 0.3.
  const steps = roundAmount(line.amount / size);
  const next =
    direction === 1 ? Math.floor(steps) + 1 : Math.ceil(steps) - 1;
  return Math.max(0, roundAmount(next * size));
}

function stepSize(line: ChecklistLine): number {
  if (line.wholeUnitsOnly) return 1;
  if (line.stockBase === "each") return line.subUnit?.perUnit ?? SPLIT_COUNT_STEP;
  return MEASURED_STEPS.find(([below]) => line.amount < below)![1];
}

/**
 * Returns the lines with the stock from a fresh plan and fresh stock for added
 * foods, marking each line whose food now has less than the line expected to
 * take. The rule matches the check the database makes before it refuses a
 * cook with `STOCK_CHANGED`. Amounts stay as the person set them.
 *
 * @param addedStock - Unexpired stock by food id for foods the plan doesn't
 * list. A food in neither has no stock left.
 */
export function reloadLines(
  lines: readonly ChecklistLine[],
  plan: CookPlan,
  addedStock: ReadonlyMap<string, number>,
): ChecklistLine[] {
  const planned = new Map(plan.foods.map((food) => [food.food_id, food.available]));
  return lines.map((line) => {
    const fresh = planned.get(line.foodId) ?? addedStock.get(line.foodId) ?? 0;
    const short = fresh < expectedAmount(line);
    return {
      ...line,
      available: fresh,
      changed: short ? changeNote(line, fresh) : null,
    };
  });
}

function changeNote(line: ChecklistLine, available: number): string {
  return available <= 0
    ? "None left now"
    : `Only ${formatAmount(available, line.unit, false, line.subUnit)} left now`;
}

/**
 * Returns the warning for a line set to use more than the stock it was
 * shown, or `null`. Cooking takes only what is there, so the line says how
 * much that is before the person confirms.
 */
export function shortfallNote(line: ChecklistLine): string | null {
  if (line.amount <= line.available) return null;
  if (line.available <= 0) return "None left to deduct";
  return `More than the ${formatAmount(line.available, line.unit, false, line.subUnit)} you have`;
}

function expectedAmount(line: ChecklistLine): number {
  return Math.min(line.amount, line.available);
}

/**
 * Returns the body of `POST /api/cook/confirm` for the checklist as set.
 *
 * Each food with an amount above 0 becomes a deduction that expects its
 * shown stock to cover as much of the amount as it can. A food set to 0 is
 * left out with its lines. A food's lines keep their converted amounts; what
 * they don't cover goes to its first question, or to its first line when it
 * has only seasoning lines, so the database can split the draws by line. A
 * food from "Add item" is recorded as a line in its own stock unit.
 */
export function confirmationBody(
  cook: ActiveCook,
  lines: readonly ChecklistLine[],
): CookConfirmationRequest {
  const used = lines.filter((line) => line.amount > 0);
  return {
    household_id: cook.householdId,
    operation_id: cook.operationId,
    recipe_id: cook.recipe.recipe_id,
    recipe_snapshot: cook.recipe,
    deductions: used.map((line) => ({
      inventory_item_id: line.foodId,
      confirmed_amount: line.amount,
      expected_amount: expectedAmount(line),
    })),
    lines: used
      .flatMap(cookLines)
      .sort((a, b) => a.position - b.position)
      .map(({ position: _position, ...line }) => line),
  };
}

type PositionedLine = CookIngredientLine & { position: number };

function cookLines(line: ChecklistLine): PositionedLine[] {
  if (line.planLines.length === 0) {
    return [
      {
        position: Infinity,
        ingredient: line.name,
        inventory_item_id: line.foodId,
        recipe_amount: line.amount,
        recipe_unit: line.unit,
        mode: "draw",
        stock_amount: line.amount,
      },
    ];
  }
  const converted = line.planLines.reduce(
    (sum, planLine) => sum + (planLine.mode === "draw" ? planLine.stock_amount! : 0),
    0,
  );
  const rest = roundAmount(line.amount - converted);
  const hasDraw = line.planLines.some((planLine) => planLine.mode === "draw");
  const answered = hasDraw
    ? line.planLines.find((planLine) => planLine.mode === "ask")
    : line.planLines[0];
  return line.planLines.map((planLine) => {
    const answers = planLine === answered && (rest > 0 || !hasDraw);
    return {
      position: planLine.line,
      ingredient: planLine.ingredient,
      inventory_item_id: line.foodId,
      recipe_amount: planLine.recipe_amount,
      recipe_unit: planLine.recipe_unit,
      mode: answers ? "ask" : planLine.mode,
      stock_amount: answers ? (hasDraw ? rest : line.amount) : planLine.stock_amount,
    };
  });
}

/**
 * Returns up to five foods whose name starts with the typed text, or has a
 * later word that does ("milk" finds "Oat milk"), leaving out foods already
 * on the checklist. Blank text matches nothing.
 *
 * @param listed - Ids of the foods already on the checklist.
 */
export function matchAddable(
  foods: readonly AddableFood[],
  query: string,
  listed: ReadonlySet<string>,
): AddableFood[] {
  const key = foodNameKey(query);
  if (key === "") return [];
  const open = foods.filter((food) => !listed.has(food.foodId));
  const starts = open.filter((food) => foodNameKey(food.name).startsWith(key));
  const wordStarts = open.filter(
    (food) =>
      !foodNameKey(food.name).startsWith(key) &&
      foodNameKey(food.name).includes(` ${key}`),
  );
  return [...starts, ...wordStarts].slice(0, ADD_ITEM_LIMIT);
}
