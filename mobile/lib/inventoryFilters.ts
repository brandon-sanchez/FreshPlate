import type { InventoryItem } from "@/hooks/useInventoryItems";
import { daysUntilExpiration } from "@/lib/expiry";
import { groupFoodRows } from "@/lib/foodRows";
import type { StorageLocation } from "@/types/inventory";

/**
 * Which lots the Inventory screen shows. An empty `locations` or `categories`
 * list means any. `categories` holds category ids, with `uncategorized` for
 * foods that have none, matching the Category view's section keys.
 */
export type InventoryFilters = {
  locations: StorageLocation[];
  categories: string[];
  /** Keeps dated lots that expire within six days, expired ones included. */
  expiringWeek: boolean;
  leftoversOnly: boolean;
};

const EXPIRING_WEEK_LAST_DAY = 6;

/** The filters that keep every lot. */
export const EMPTY_FILTERS: InventoryFilters = {
  locations: [],
  categories: [],
  expiringWeek: false,
  leftoversOnly: false,
};

/** One choice in a filter list, with how many foods it holds. */
export type FilterOption<T extends string = string> = {
  value: T;
  label: string;
  count: number;
};

/** The places and categories the filter menu offers, from {@link filterOptions}. */
export type FilterChoices = {
  locations: FilterOption<StorageLocation>[];
  categories: FilterOption[];
};

/** The filters chosen from a list of options, in menu order, with their menu labels. */
export const FILTER_LISTS = [
  { key: "locations", label: "Location" },
  { key: "categories", label: "Category" },
] as const satisfies readonly { key: keyof FilterChoices; label: string }[];

/** The yes-or-no filters, in menu order, with their menu and summary labels. */
export const FILTER_SWITCHES = [
  { key: "expiringWeek", label: "Expiring this week" },
  { key: "leftoversOnly", label: "Leftovers only" },
] as const satisfies readonly { key: keyof InventoryFilters; label: string }[];

type FilterList = (typeof FILTER_LISTS)[number]["key"];
type FilterSwitch = (typeof FILTER_SWITCHES)[number]["key"];

/** Returns how many filter values are on: each place, each category and each switch. */
export function countActiveFilters(filters: InventoryFilters): number {
  return (
    filters.locations.length +
    filters.categories.length +
    FILTER_SWITCHES.filter(({ key }) => filters[key]).length
  );
}

/** Returns `filters` with `value` added to or removed from the `key` list. */
export function toggleChoice<K extends FilterList>(
  filters: InventoryFilters,
  key: K,
  value: InventoryFilters[K][number],
): InventoryFilters {
  const list: string[] = filters[key];
  return {
    ...filters,
    [key]: list.includes(value)
      ? list.filter((item) => item !== value)
      : [...list, value],
  };
}

/** Returns `filters` with the `key` switch flipped. */
export function toggleSwitch(
  filters: InventoryFilters,
  key: FilterSwitch,
): InventoryFilters {
  return { ...filters, [key]: !filters[key] };
}

/**
 * Returns the value a filter list's menu row shows: "All" when nothing is
 * chosen, the label when one option is, otherwise how many are.
 */
export function summarizeChoices(
  chosen: string[],
  options: FilterOption[],
): string {
  if (chosen.length === 0) return "All";
  if (chosen.length > 1) return `${chosen.length} selected`;
  return labelOf(options, chosen[0]) ?? "1 selected";
}

/**
 * Returns the lots whose name contains `query`, ignoring case and outer
 * spaces, and that pass every filter.
 */
export function filterInventory(
  lots: InventoryItem[],
  query: string,
  filters: InventoryFilters,
): InventoryItem[] {
  const needle = query.trim().toLowerCase();
  return lots.filter((lot) => {
    if (needle && !lot.name.toLowerCase().includes(needle)) return false;
    if (
      filters.locations.length &&
      !filters.locations.includes(lot.storage_location)
    )
      return false;
    if (
      filters.categories.length &&
      !filters.categories.includes(categoryKey(lot))
    )
      return false;
    if (filters.leftoversOnly && !lot.is_leftover) return false;
    if (filters.expiringWeek) {
      const days = daysUntilExpiration(lot.expiration_date);
      if (days === null || days > EXPIRING_WEEK_LAST_DAY) return false;
    }
    return true;
  });
}

/**
 * Returns the places and categories the filter menu offers for `lots`. Every
 * place is offered; categories are the ones in stock, most urgent first, as
 * the Category view orders them. Counts are foods, as the section headers
 * count them.
 */
export function filterOptions(lots: InventoryItem[]): FilterChoices {
  return {
    locations: groupFoodRows(lots, "Location").map((section) => ({
      value: section.key as StorageLocation,
      label: section.label,
      count: section.data.length,
    })),
    categories: groupFoodRows(lots, "Category").map((section) => ({
      value: section.key,
      label: section.label,
      count: section.data.length,
    })),
  };
}

/**
 * Returns the active filters as short phrases for the summary line: each
 * place, then one category by name or several by count, then the switches.
 * `options` supplies the labels, from {@link filterOptions}. A chosen
 * category that is no longer in stock reads "1 category".
 */
export function describeFilters(
  filters: InventoryFilters,
  options: FilterChoices,
): string[] {
  const parts = filters.locations.map(
    (location) => labelOf(options.locations, location) ?? location,
  );
  if (filters.categories.length === 1) {
    parts.push(
      labelOf(options.categories, filters.categories[0]) ?? "1 category",
    );
  } else if (filters.categories.length > 1) {
    parts.push(`${filters.categories.length} categories`);
  }
  for (const { key, label } of FILTER_SWITCHES)
    if (filters[key]) parts.push(label);
  return parts;
}

function labelOf(options: FilterOption[], value: string): string | undefined {
  return options.find((option) => option.value === value)?.label;
}

function categoryKey(lot: InventoryItem): string {
  return lot.category?.id ?? "uncategorized";
}
