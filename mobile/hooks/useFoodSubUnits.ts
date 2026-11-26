import { useQuery } from "@tanstack/react-query";
import type { SubUnit } from "@/lib/amount";
import { supabase } from "@/lib/supabase";
import { useAuthStore } from "@/stores/auth";

type FoodUnitRow = { food_id: string; unit_key: string; base_per_unit: number };

/** Each food's smaller unit, keyed by food id. */
export type SubUnits = Readonly<Record<string, SubUnit>>;

const NO_SUB_UNITS: SubUnits = {};
// A sub-unit shows a fraction as whole sub-units, so it must split one stock
// unit into a whole number of parts: 0.1 head is 10 cloves, 0.3 is refused.
const WHOLE_PARTS_TOLERANCE = 1e-6;

/**
 * Returns each food's smaller unit by food id, such as a clove for a head of
 * garlic, for `formatAmount` and the checklist stepper. A food's
 * smaller unit is its largest household unit that splits one of its stock
 * unit into two or more whole parts. A food without one is absent.
 *
 * Reads the `food_units` table under the query key
 * `['inventory', householdId, 'sub-units']`, so every inventory invalidation
 * refetches it. Returns an empty map until the household id is known or
 * while the read is pending or failed, so amounts fall back to decimals.
 */
export function useFoodSubUnits(): SubUnits {
  const householdId = useAuthStore((s) => s.householdId);
  const query = useQuery({
    queryKey: ["inventory", householdId, "sub-units"],
    enabled: householdId !== null,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("food_units")
        .select("food_id, unit_key, base_per_unit")
        .eq("household_id", householdId!);
      if (error) throw error;
      return subUnitsByFood((data ?? []) as FoodUnitRow[]);
    },
  });
  return query.data ?? NO_SUB_UNITS;
}

// A plain object, not a Map, so TanStack Query's structural sharing keeps it
// identical across refetches and rows don't re-render for unchanged data.
function subUnitsByFood(rows: readonly FoodUnitRow[]): SubUnits {
  const byFood: Record<string, SubUnit> = {};
  for (const row of rows) {
    const perUnit = Number(row.base_per_unit);
    if (!splitsWhole(perUnit)) continue;
    const best = byFood[row.food_id];
    if (!best || perUnit > best.perUnit) {
      byFood[row.food_id] = { label: row.unit_key, perUnit };
    }
  }
  return byFood;
}

function splitsWhole(perUnit: number): boolean {
  const parts = 1 / perUnit;
  return parts >= 2 && Math.abs(parts - Math.round(parts)) < WHOLE_PARTS_TOLERANCE;
}
