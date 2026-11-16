import { compareDays } from "@/lib/expiry";
import type { FoodRow, FoodSection } from "@/lib/foodRows";

type Compare = (a: FoodRow, b: FoodRow) => number;

const MEASURED_BASE_RANK: Record<string, number> = { g: 0, ml: 1 };
const COUNTED_RANK = 2;

const SORTS = {
  "expiry-soonest": {
    label: "Expiry: soonest first",
    compare: (a, b) => compareDays(a.days, b.days),
  },
  "expiry-latest": {
    label: "Expiry: latest first",
    compare: (a, b) => compareDays(a.days, b.days, -1),
  },
  "name-asc": { label: "Name: A to Z", compare: (a, b) => compareNames(a, b) },
  "name-desc": { label: "Name: Z to A", compare: (a, b) => compareNames(b, a) },
  "amount-desc": {
    label: "Amount: high to low",
    compare: (a, b) => baseRank(a) - baseRank(b) || b.total - a.total,
  },
  "amount-asc": {
    label: "Amount: low to high",
    compare: (a, b) => baseRank(a) - baseRank(b) || a.total - b.total,
  },
  recent: {
    label: "Recently added",
    compare: (a, b) => b.lastAddedAt - a.lastAddedAt,
  },
} as const satisfies Record<string, { label: string; compare: Compare }>;

/** How rows are ordered inside each inventory section. */
export type SortBy = keyof typeof SORTS;

/** Every sort, in the order the sort menu lists them. */
export const SORT_OPTIONS = Object.keys(SORTS) as SortBy[];

/** The sort a section uses until someone picks another. */
export const DEFAULT_SORT: SortBy = "expiry-soonest";

/** Returns the label the sort control shows for `sortBy`, such as "Name: A to Z". */
export function sortLabel(sortBy: SortBy): string {
  return SORTS[sortBy].label;
}

/** True when `value` names a sort, for reading a stored choice. */
export function isSortBy(value: unknown): value is SortBy {
  return SORT_OPTIONS.some((sortBy) => sortBy === value);
}

/**
 * Returns `rows` in the order of `sortBy`, ties broken by name. Expiry sorts
 * keep undated rows last in both directions, so "soonest first" opens with
 * expired rows. Amount sorts list weighed foods, then liquids, then counted
 * foods, and compare totals only inside each of those groups, because 500 g
 * and 3 cans have no common scale. Counted foods compare by count whatever
 * their count word, so 12 eggs rank above 3 cans.
 */
export function sortFoodRows(rows: FoodRow[], sortBy: SortBy): FoodRow[] {
  const { compare } = SORTS[sortBy];
  return [...rows].sort((a, b) => compare(a, b) || compareNames(a, b));
}

/**
 * Returns `sections` in the same order with each one's rows sorted by
 * {@link sortFoodRows}, so a sort never moves a row into another section.
 */
export function sortSections(
  sections: FoodSection[],
  sortBy: SortBy,
): FoodSection[] {
  return sections.map((section) => ({
    ...section,
    data: sortFoodRows(section.data, sortBy),
  }));
}

function compareNames(a: FoodRow, b: FoodRow): number {
  return (
    a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) ||
    a.foodId.localeCompare(b.foodId)
  );
}

function baseRank(row: FoodRow): number {
  return MEASURED_BASE_RANK[row.unit] ?? COUNTED_RANK;
}
