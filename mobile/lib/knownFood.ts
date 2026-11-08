import type { MeasuredBase } from "@/lib/stockUnit";
import type { StorageLocation } from "@/types/inventory";

type FoodStock =
  | { base: MeasuredBase }
  | {
      base: "each";
      eachLabel: string;
      /** The size of one counted item, or `null` when the food does not know it. */
      sizeEach: { amount: number; base: MeasuredBase } | null;
    };

/** A food's most recent lot that was not deleted as a mistake, as a template for the next add. */
export type LastLot = {
  storage: StorageLocation;
  /**
   * Whole days from the lot's local add date to its expiration date, or `null`
   * when the lot has no date or the date is not after the add date.
   */
  shelfLifeDays: number | null;
  /** The lot's starting amount in the food's stock base; `null` for lots moved over from the old inventory table. */
  initialQuantity: number | null;
  /** The package the lot came in, with its size in the food's stock base. */
  package: { label: string; size: number } | null;
};

/** A household food the add form can match a typed name to. */
export type KnownFood = {
  id: string;
  name: string;
  /** The name as `food_name_key` normalized it in the database. */
  nameKey: string;
  categoryId: string | null;
  /** How the food is stocked. Mirrors the CHECK on `foods`: only a counted food has an each label. */
  stock: FoodStock;
  /** `null` when the food has never had a lot. */
  lastLot: LastLot | null;
  /**
   * Whether the household still sees the food. An archived food comes back when
   * something is added to it; a merged food is always archived and hands its
   * adds to the food it was merged into.
   */
  status:
    | { kind: "live" }
    | { kind: "archived" }
    | { kind: "merged"; intoId: string };
};

const SUGGESTION_LIMIT = 6;
// Mirrors the hop limit `add_lot` puts on a chain of merged foods.
const MAX_MERGE_HOPS = 8;

/**
 * Returns up to six live foods to suggest for the typed name, keeping the order
 * of `foods`. A blank name gives the first six. Otherwise names that start with
 * the text come first, then names with a later word that starts with it
 * ("milk" finds "Oat milk"); text in the middle of a word does not match. The
 * food whose name is exactly the typed name is left out.
 */
export function suggestFoods(
  foods: readonly KnownFood[],
  query: string,
): KnownFood[] {
  const live = foods.filter((food) => food.status.kind === "live");
  const key = foodNameKey(query);
  if (key === "") return live.slice(0, SUGGESTION_LIMIT);
  const starts: KnownFood[] = [];
  const wordStarts: KnownFood[] = [];
  for (const food of live) {
    if (food.nameKey === key) continue;
    if (food.nameKey.startsWith(key)) starts.push(food);
    else if (food.nameKey.includes(` ${key}`)) wordStarts.push(food);
  }
  return [...starts, ...wordStarts].slice(0, SUGGESTION_LIMIT);
}

/**
 * Returns the food `add_lot` would add the name to, or `null` for a new food.
 * Matches names the way the database does and follows merged foods to the
 * food they were merged into. An archived food still matches, because adding
 * to it brings it back.
 */
export function findFood(
  foods: readonly KnownFood[],
  name: string,
): KnownFood | null {
  const key = foodNameKey(name);
  if (key === "") return null;
  let food = foods.find((candidate) => candidate.nameKey === key);
  for (let hop = 0; food?.status.kind === "merged"; hop++) {
    if (hop === MAX_MERGE_HOPS) return null;
    const { intoId } = food.status;
    food = foods.find((candidate) => candidate.id === intoId);
  }
  return food ?? null;
}

/**
 * Returns the key the database stores for a food name. Mirrors
 * `public.food_name_key`: whitespace runs collapse to one space, then the name
 * is trimmed and lowercased.
 */
function foodNameKey(name: string): string {
  return name.replace(/\s+/g, " ").trim().toLowerCase();
}
