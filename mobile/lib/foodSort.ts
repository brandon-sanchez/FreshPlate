import { compareDays } from "@/lib/expiry";
import type { FoodRow, FoodSection } from "@/lib/foodRows";

type Compare = (a: FoodRow, b: FoodRow) => number;

const MEASURED_BASE_RANK: Record<string, number> = { g: 0, ml: 1 };
const COUNTED_RANK = 2;

const SORTS = {
  "expiry-soonest": (a, b) => compareDays(a.days, b.days),
  "expiry-latest": (a, b) => compareDays(a.days, b.days, -1),
  "name-asc": (a, b) => compareNames(a, b),
  "name-desc": (a, b) => compareNames(b, a),
  "amount-desc": (a, b) => baseRank(a) - baseRank(b) || b.total - a.total,
  "amount-asc": (a, b) => baseRank(a) - baseRank(b) || a.total - b.total,
  recent: (a, b) => b.lastAddedAt - a.lastAddedAt,
} as const satisfies Record<string, Compare>;

/** How rows are ordered inside each inventory section. */
export type SortBy = keyof typeof SORTS;

/** The sort a section uses until someone picks another. */
export const DEFAULT_SORT: SortBy = "expiry-soonest";

/**
 * The sorts as the sort menu lists them: one entry per thing to sort by, each
 * with its directions in the order a repeated tap cycles through them. A
 * direction's `label` names it in the menu; `summary` names it after the
 * family label in the line under the tabs.
 */
export const SORT_FAMILIES = [
  {
    key: "expiry",
    label: "Expiry date",
    directions: [
      {
        sortBy: "expiry-soonest",
        label: "Soonest first",
        summary: "soonest first",
      },
      {
        sortBy: "expiry-latest",
        label: "Latest first",
        summary: "latest first",
      },
    ],
  },
  {
    key: "name",
    label: "Name",
    directions: [
      { sortBy: "name-asc", label: "A to Z", summary: "A to Z" },
      { sortBy: "name-desc", label: "Z to A", summary: "Z to A" },
    ],
  },
  {
    key: "amount",
    label: "Amount",
    directions: [
      { sortBy: "amount-desc", label: "Most first", summary: "most first" },
      { sortBy: "amount-asc", label: "Least first", summary: "least first" },
    ],
  },
  {
    key: "recent",
    label: "Recently added",
    directions: [
      { sortBy: "recent", label: "Newest first", summary: "newest first" },
    ],
  },
] as const satisfies readonly {
  key: string;
  label: string;
  directions: readonly { sortBy: SortBy; label: string; summary: string }[];
}[];

/** One entry of {@link SORT_FAMILIES}, such as Name. */
export type SortFamily = (typeof SORT_FAMILIES)[number]["key"];

/** True when `value` names a sort, for reading a stored choice. */
export function isSortBy(value: unknown): value is SortBy {
  return typeof value === "string" && Object.hasOwn(SORTS, value);
}

/**
 * Returns the sort that tapping `family` in the menu picks: its first
 * direction when another family is selected, otherwise its next direction.
 * A family with one direction keeps it.
 */
export function nextSort(family: SortFamily, current: SortBy): SortBy {
  const { directions } = familyEntry(family);
  const index = directions.findIndex(
    (direction) => direction.sortBy === current,
  );
  return directions[(index + 1) % directions.length].sortBy;
}

/**
 * Returns the family `sortBy` belongs to, the menu label of its direction,
 * and whether that direction is the family's second one, which the menu
 * shows by turning the direction arrow over.
 */
export function sortDirection(sortBy: SortBy): {
  family: SortFamily;
  label: string;
  reversed: boolean;
} {
  const { family, index } = locate(sortBy);
  return {
    family: family.key,
    label: family.directions[index].label,
    reversed: index === 1,
  };
}

/** Returns the sort as the line under the tabs states it, such as "Name, Z to A". */
export function sortSummary(sortBy: SortBy): string {
  const { family, index } = locate(sortBy);
  return `${family.label}, ${family.directions[index].summary}`;
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
  const compare: Compare = SORTS[sortBy];
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

function familyEntry(key: SortFamily) {
  return SORT_FAMILIES.find((family) => family.key === key) ?? SORT_FAMILIES[0];
}

function locate(sortBy: SortBy) {
  for (const family of SORT_FAMILIES) {
    const index = family.directions.findIndex(
      (direction) => direction.sortBy === sortBy,
    );
    if (index !== -1) return { family, index };
  }
  return { family: SORT_FAMILIES[0], index: 0 };
}
