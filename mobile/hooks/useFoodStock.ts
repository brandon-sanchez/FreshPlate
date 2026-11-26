import { useQuery } from "@tanstack/react-query";
import type { AddableFood } from "@/lib/cook-checklist";
import { supabase } from "@/lib/supabase";
import { useAuthStore } from "@/stores/auth";
import type { StockBase } from "@/types/cook";

type FoodStockRow = {
  id: string;
  name: string;
  stock_base: StockBase;
  each_label: string | null;
  whole_units_only: boolean;
  available: number;
};

/**
 * Returns the household's foods with unexpired stock, by name. These are the
 * foods recipes may cook with, so a kitchen basic named like one of them is
 * deducted like any food.
 *
 * Reads the `food_stock` view under the query key
 * `['inventory', householdId, 'stock']`, so every inventory invalidation
 * refetches it. Stays idle until the auth store has a household id.
 */
export function useFoodStock() {
  const householdId = useAuthStore((s) => s.householdId);
  return useQuery({
    queryKey: ["inventory", householdId, "stock"],
    enabled: householdId !== null,
    queryFn: () => readFoodStock(householdId!),
  });
}

async function readFoodStock(householdId: string): Promise<AddableFood[]> {
  const { data, error } = await supabase
    .from("food_stock")
    .select("id, name, stock_base, each_label, whole_units_only, available")
    .eq("household_id", householdId)
    .gt("available", 0)
    .order("name");
  if (error) throw error;
  return ((data ?? []) as FoodStockRow[]).map((row) => ({
    foodId: row.id,
    name: row.name,
    stockBase: row.stock_base,
    unit: row.each_label ?? row.stock_base,
    available: row.available,
    wholeUnitsOnly: row.whole_units_only,
    subUnit: null,
  }));
}
