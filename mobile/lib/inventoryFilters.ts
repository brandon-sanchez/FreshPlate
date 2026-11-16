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

/** Returns how many filter values are on: each place, each category and each switch. */
export function countActiveFilters(filters: InventoryFilters): number {
  return (
    filters.locations.length +
    filters.categories.length +
    (filters.expiringWeek ? 1 : 0) +
    (filters.leftoversOnly ? 1 : 0)
  );
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
export function filterOptions(lots: InventoryItem[]): {
  locations: FilterOption<StorageLocation>[];
  categories: FilterOption[];
} {
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
 * `options` supplies the labels, from {@link filterOptions}.
 */
export function describeFilters(
  filters: InventoryFilters,
  options: ReturnType<typeof filterOptions>,
): string[] {
  const labelOf = (list: FilterOption[], value: string) =>
    list.find((option) => option.value === value)?.label ?? value;
  const parts = filters.locations.map((location) =>
    labelOf(options.locations, location),
  );
  if (filters.categories.length === 1) {
    parts.push(labelOf(options.categories, filters.categories[0]));
  } else if (filters.categories.length > 1) {
    parts.push(`${filters.categories.length} categories`);
  }
  if (filters.expiringWeek) parts.push("Expiring this week");
  if (filters.leftoversOnly) parts.push("Leftovers only");
  return parts;
}

function categoryKey(lot: InventoryItem): string {
  return lot.category?.id ?? "uncategorized";
}
