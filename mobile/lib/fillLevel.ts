import type { InventoryItem } from "@/hooks/useInventoryItems";

type FillLevel = { label: "Full" | "3/4" | "1/2" | "1/4"; fraction: number };

/** The "how full" choices, fullest first, each with the share of the full size it leaves. */
export const FILL_LEVELS: readonly FillLevel[] = [
  { label: "Full", fraction: 1 },
  { label: "3/4", fraction: 0.75 },
  { label: "1/2", fraction: 0.5 },
  { label: "1/4", fraction: 0.25 },
];

type SizedLot = Pick<InventoryItem, "quantity" | "initial_quantity" | "whole_units_only">;

/**
 * How a batch's remaining amount is set. `levels`: by "how full" or an exact
 * amount. `unknownSize`: the batch was backfilled from `inventory_items` and
 * has no full size, so only an exact amount. `count`: the food is counted in
 * whole units, where a share of one can would be fractional, so only a whole
 * exact count.
 */
export type RemainingMode = "levels" | "unknownSize" | "count";

/** Returns how the batch's remaining amount is set. */
export function remainingMode(lot: SizedLot): RemainingMode {
  if (lot.whole_units_only) return "count";
  return lot.initial_quantity === null ? "unknownSize" : "levels";
}

/** Returns the fill level the batch's amount matches, or `null` for any other amount. */
export function currentFillLevel(lot: SizedLot): FillLevel | null {
  const full = lot.initial_quantity;
  if (full === null) return null;
  return (
    FILL_LEVELS.find((level) => Math.abs(level.fraction * full - lot.quantity) < full * 1e-9) ??
    null
  );
}

/**
 * Parses a typed exact amount, accepting a comma as the decimal mark.
 * Returns `null` unless it is a finite positive number, and a whole number
 * when `wholeUnitsOnly` is true.
 */
export function parseExactAmount(text: string, wholeUnitsOnly: boolean): number | null {
  if (text.trim() === "") return null;
  const amount = Number(text.replace(",", "."));
  const valid = Number.isFinite(amount) && amount > 0 && (!wholeUnitsOnly || Number.isInteger(amount));
  return valid ? amount : null;
}
