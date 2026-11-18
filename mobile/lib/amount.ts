import { pluralize } from "@/lib/recipe-format";
import { toMeasure, unitWord } from "@/lib/stockUnit";

/**
 * A household unit smaller than one of a counted food's stock unit, such as a
 * clove of a head of garlic. `perUnit` is the stock amount one of it stands
 * for: 0.1 head per clove.
 */
export type SubUnit = { label: string; perUnit: number };

const COUNT_DECIMALS = 2;
const WHOLE_G_ML_FROM = 10;
const SMALL_BASE_DECIMALS = 1;
const KG_L_DECIMALS = 3;
const EACH = "each";

/**
 * Formats an amount in its stock unit, as every screen shows stock:
 * "570 ml", "3.09 l", "1 lemon", "7 eggs", and "about" before an estimate.
 *
 * Weights and volumes switch to kg or l from 1000. A count names its word in
 * the singular for exactly 1 and in the plural otherwise, whatever form the
 * word was stored in. A counted food with a `subUnit` shows its fraction in
 * that unit: 0.2 head of garlic is "2 cloves", and 1.8 heads is
 * "1 head 8 cloves". An amount under half a sub-unit falls back to decimals.
 *
 * @param unit - "g", "ml", or a count word such as "egg" or "each".
 * @param estimate - Whether the amount, or any amount summed into it, is an estimate.
 * @param subUnit - The food's smaller unit, if it has one. Ignored for g and ml.
 */
export function formatAmount(
  quantity: number,
  unit: string,
  estimate: boolean,
  subUnit: SubUnit | null = null,
): string {
  const amount =
    unit === "g" || unit === "ml"
      ? measuredText(quantity, unit)
      : countText(quantity, unit, subUnit);
  return estimate ? `about ${amount}` : amount;
}

function measuredText(quantity: number, unit: "g" | "ml"): string {
  // Rounded first, so 999.6 g reads "1 kg", not "1000 g".
  const rounded = Number(
    quantity.toFixed(quantity >= WHOLE_G_ML_FROM ? 0 : SMALL_BASE_DECIMALS),
  );
  const measured = toMeasure(rounded, unit);
  const places =
    measured.unit !== unit
      ? KG_L_DECIMALS
      : measured.amount >= WHOLE_G_ML_FROM
        ? 0
        : SMALL_BASE_DECIMALS;
  return `${shortNumber(measured.amount, places)} ${measured.unit}`;
}

function countText(quantity: number, unit: string, subUnit: SubUnit | null): string {
  const parts = subUnit ? Math.round(quantity / subUnit.perUnit) : 0;
  if (!subUnit || (parts === 0 && quantity > 0)) {
    return counted(Number(quantity.toFixed(COUNT_DECIMALS)), unit);
  }
  const perWhole = Math.round(1 / subUnit.perUnit);
  const whole = Math.floor(parts / perWhole);
  const rest = parts - whole * perWhole;
  if (rest === 0) return counted(whole, unit);
  const restText = counted(rest, subUnit.label);
  return whole > 0 ? `${counted(whole, unit)} ${restText}` : restText;
}

function counted(count: number, unit: string): string {
  const word = unitWord(unit);
  if (word === EACH) return `${count} ${EACH}`;
  return `${count} ${count === 1 ? word : pluralize(word)}`;
}

function shortNumber(value: number, places: number): string {
  return String(Number(value.toFixed(places)));
}
