import { useQuery } from "@tanstack/react-query";
import type { KnownFood } from "@/lib/knownFood";
import type { MeasuredBase } from "@/lib/stockUnit";
import { supabase } from "@/lib/supabase";
import { useAuthStore } from "@/stores/auth";
import type { StorageLocation } from "@/types/inventory";

type LotRow = {
  initial_quantity: number | null;
  package_size: number | null;
  package_label: string | null;
  storage_location: StorageLocation;
  expiration_date: string | null;
  created_at: string;
};

type FoodRow = {
  id: string;
  name: string;
  name_key: string;
  category_id: string | null;
  grams_per_each: number | null;
  ml_per_each: number | null;
  archived_at: string | null;
  merged_into_id: string | null;
  lots: LotRow[];
} & (
  | { stock_base: MeasuredBase; each_label: null }
  | { stock_base: "each"; each_label: string }
);

const SELECT = `
  id, name, name_key, category_id, stock_base, each_label, grams_per_each, ml_per_each,
  archived_at, merged_into_id,
  lots(initial_quantity, package_size, package_label, storage_location, expiration_date, created_at)
` as const;

// A lot depleted as "corrected" was entered by mistake, so it is no template
// for the next add. PostgREST's neq drops NULLs, so lots still in stock need
// their own branch.
const TEMPLATE_LOTS = "depleted_reason.is.null,depleted_reason.neq.corrected";

const DAY_MS = 86400000;

/**
 * Returns every food in the household, archived and merged ones included, with
 * its latest lot that was not corrected away, most recently added first. Reads
 * `foods` and `lots` under the query key `['inventory', householdId, 'foods']`,
 * so the `['inventory']` invalidation of every inventory mutation refetches it.
 * Waits until the household id is known.
 */
export function useHouseholdFoods() {
  const householdId = useAuthStore((s) => s.householdId);

  return useQuery({
    queryKey: ["inventory", householdId, "foods"],
    enabled: !!householdId,
    queryFn: async (): Promise<KnownFood[]> => {
      const { data, error } = await supabase
        .from("foods")
        .select(SELECT)
        .eq("household_id", householdId!)
        .or(TEMPLATE_LOTS, { referencedTable: "lots" })
        .order("created_at", { referencedTable: "lots", ascending: false })
        .limit(1, { referencedTable: "lots" });

      if (error) throw error;
      const rows = (data ?? []) as unknown as FoodRow[];
      return rows
        .map((row) => ({
          food: toKnownFood(row),
          addedAt: row.lots[0]?.created_at ?? "",
        }))
        .sort((a, b) => b.addedAt.localeCompare(a.addedAt))
        .map(({ food }) => food);
    },
  });
}

function toKnownFood(row: FoodRow): KnownFood {
  const lot = row.lots[0];
  return {
    id: row.id,
    name: row.name,
    nameKey: row.name_key,
    categoryId: row.category_id,
    stock:
      row.stock_base === "each"
        ? { base: "each", eachLabel: row.each_label, sizeEach: sizeEach(row) }
        : { base: row.stock_base },
    lastLot: lot
      ? {
          storage: lot.storage_location,
          shelfLifeDays: shelfLifeDays(lot.created_at, lot.expiration_date),
          initialQuantity: lot.initial_quantity,
          package:
            lot.package_label !== null && lot.package_size !== null
              ? { label: lot.package_label, size: lot.package_size }
              : null,
        }
      : null,
    status:
      row.merged_into_id !== null
        ? { kind: "merged", intoId: row.merged_into_id }
        : row.archived_at !== null
          ? { kind: "archived" }
          : { kind: "live" },
  };
}

function sizeEach(row: FoodRow): { amount: number; base: MeasuredBase } | null {
  if (row.grams_per_each !== null) {
    return { amount: row.grams_per_each, base: "g" };
  }
  if (row.ml_per_each !== null) return { amount: row.ml_per_each, base: "ml" };
  return null;
}

function shelfLifeDays(
  createdAt: string,
  expirationDate: string | null,
): number | null {
  if (!expirationDate) return null;
  const added = new Date(createdAt);
  const [y, m, d] = expirationDate.split("-").map(Number);
  const addedDay = new Date(
    added.getFullYear(),
    added.getMonth(),
    added.getDate(),
  );
  const days = Math.round(
    (new Date(y, m - 1, d).getTime() - addedDay.getTime()) / DAY_MS,
  );
  return Number.isFinite(days) && days > 0 ? days : null;
}
