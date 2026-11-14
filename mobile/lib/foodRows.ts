import type { InventoryItem } from "@/hooks/useInventoryItems";
import { daysUntilExpiration } from "@/lib/expiry";

type StorageLocation = InventoryItem["storage_location"];

/** One food as an inventory row: the live lots of one food that fall in the same section, stacked. */
export type FoodRow = {
  /** Unique within one list: the food id, prefixed with the section key inside a section. */
  key: string;
  foodId: string;
  name: string;
  /** The food's stock unit, shared by every lot of the food. */
  unit: string;
  category: InventoryItem["category"];
  isLeftover: boolean;
  /** Never empty. Soonest expiry first, undated lots last. */
  lots: InventoryItem[];
  /**
   * Sum of the unexpired lots' quantities, in `unit`, because expired stock
   * is not available until someone reviews it. When every lot has expired,
   * the sum of the expired lots, so an Expired row still says how much is
   * waiting for review.
   */
  total: number;
  /** True when any lot counted in `total` is an estimate, so the total reads "about". */
  isEstimate: boolean;
  /** Distinct locations of the lots, in fridge, freezer, pantry order. */
  locations: StorageLocation[];
  /**
   * Days until the soonest unexpired dated lot expires, so one forgotten
   * expired batch does not make a fresh restock look expired. `null` when
   * the only unexpired lots are undated, or no lot has a date. When every
   * lot has expired, the most overdue lot's (negative) days.
   */
  days: number | null;
  /** The Urgency section the row belongs to, derived from `days`. */
  urgency: Urgency;
  /** Number of lots whose date has passed. */
  expiredLots: number;
};

/**
 * How soon a row needs using: `expired` (date passed), `today` (today or
 * tomorrow), `week` (2 to 6 days), or `fresh` (later, or undated).
 */
export type Urgency = "expired" | "today" | "week" | "fresh";

/** How the inventory screen partitions its rows into sections. */
export type GroupBy = "Urgency" | "Location" | "Category";

/** One inventory section. `tone` colors the header for the urgent Urgency buckets. */
export type FoodSection = {
  key: string;
  label: string;
  tone?: "crit" | "warn";
  data: FoodRow[];
};

const LOCATIONS: StorageLocation[] = ["fridge", "freezer", "pantry"];

const URGENCY_SECTIONS: { key: Urgency; label: string; tone?: FoodSection["tone"] }[] = [
  { key: "expired", label: "Expired", tone: "crit" },
  { key: "today", label: "Use today or tomorrow", tone: "warn" },
  { key: "week", label: "This week" },
  { key: "fresh", label: "Fresh" },
];

/**
 * Stacks lots into one row per food, sorted by urgency (soonest `days` first,
 * undated last), then by name.
 */
export function stackLots(lots: InventoryItem[]): FoodRow[] {
  const byFood = new Map<string, InventoryItem[]>();
  for (const lot of lots) {
    const group = byFood.get(lot.food_id);
    if (group) group.push(lot);
    else byFood.set(lot.food_id, [lot]);
  }
  return Array.from(byFood.values(), toRow).sort(
    (a, b) => compareDays(a.days, b.days) || a.name.localeCompare(b.name),
  );
}

/**
 * Splits lots into the sections of one inventory view, stacking each
 * section's lots per food. The Urgency and Category views hold one row per
 * food. The Location view partitions lots by place first, so a food stored in
 * two places has a row in each place's section holding only that place's lots.
 * The Urgency and Location views return every section, even empty ones.
 * Rows inside each section are sorted as {@link stackLots} sorts them.
 */
export function groupFoodRows(lots: InventoryItem[], groupBy: GroupBy): FoodSection[] {
  if (groupBy === "Location") {
    return LOCATIONS.map((loc) => ({
      key: loc,
      label: capitalize(loc),
      data: inSection(loc, stackLots(lots.filter((l) => l.storage_location === loc))),
    }));
  }

  if (groupBy === "Urgency") {
    const rows = stackLots(lots);
    return URGENCY_SECTIONS.map((section) => ({
      ...section,
      data: inSection(section.key, rows.filter((r) => r.urgency === section.key)),
    }));
  }

  const byCategory = new Map<string, FoodSection>();
  for (const row of stackLots(lots)) {
    const key = row.category?.id ?? "uncategorized";
    const section = byCategory.get(key) ?? {
      key,
      label: row.category?.name ?? "Uncategorized",
      data: [],
    };
    section.data.push(row);
    byCategory.set(key, section);
  }
  return Array.from(byCategory.values(), (s) => ({ ...s, data: inSection(s.key, s.data) }));
}

/** One lot of a food with its place in draw order. */
export type DrawnLot = {
  lot: InventoryItem;
  /** Days until the lot expires, or `null` when it has no date. */
  days: number | null;
  /** True when the expiration date has passed. */
  expired: boolean;
  /** True only on the first unexpired lot in draw order. */
  useFirst: boolean;
};

/**
 * Orders one food's lots for drawing: unexpired before expired, then opened
 * before sealed, then soonest expiry with undated lots last, then oldest
 * added, then lot id so lots added together keep a stable order. A food
 * whose every lot has expired has no `useFirst` lot.
 */
export function inDrawOrder(lots: InventoryItem[]): DrawnLot[] {
  const ordered = lots
    .map((lot) => {
      const days = daysUntilExpiration(lot.expiration_date);
      return { lot, days, expired: days !== null && days < 0, useFirst: false };
    })
    .sort(
      (a, b) =>
        Number(a.expired) - Number(b.expired) ||
        Number(a.lot.opened_at === null) - Number(b.lot.opened_at === null) ||
        compareDays(a.days, b.days) ||
        Date.parse(a.lot.created_at) - Date.parse(b.lot.created_at) ||
        a.lot.id.localeCompare(b.lot.id),
    );
  if (ordered.length > 0 && !ordered[0].expired) ordered[0].useFirst = true;
  return ordered;
}

function inSection(sectionKey: string, rows: FoodRow[]): FoodRow[] {
  return rows.map((row) => ({ ...row, key: `${sectionKey}:${row.foodId}` }));
}

function toRow(group: InventoryItem[]): FoodRow {
  const withDays = group.map((lot) => ({ lot, days: daysUntilExpiration(lot.expiration_date) }));
  withDays.sort((a, b) => compareDays(a.days, b.days));
  const lots = withDays.map((d) => d.lot);
  const expired = withDays.filter((d) => d.days !== null && d.days < 0);
  const unexpired = withDays.filter((d) => d.days === null || d.days >= 0);
  const days = unexpired.length ? unexpired[0].days : expired[0].days;
  const counted = (unexpired.length ? unexpired : expired).map((d) => d.lot);
  const [first] = lots;

  return {
    key: first.food_id,
    foodId: first.food_id,
    name: first.name,
    unit: first.unit,
    category: first.category,
    isLeftover: first.is_leftover,
    lots,
    total: counted.reduce((sum, lot) => sum + lot.quantity, 0),
    isEstimate: counted.some((lot) => lot.is_estimate),
    locations: LOCATIONS.filter((loc) => lots.some((lot) => lot.storage_location === loc)),
    days,
    urgency: urgencyOf(days),
    expiredLots: expired.length,
  };
}

function urgencyOf(days: number | null): Urgency {
  if (days === null) return "fresh";
  if (days < 0) return "expired";
  if (days <= 1) return "today";
  if (days <= 6) return "week";
  return "fresh";
}

function compareDays(a: number | null, b: number | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a - b;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
