import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { useAuthStore } from "@/stores/auth";

type Category = {
  id: string;
  name: string;
  icon: string | null;
};

/**
 * One live lot as the inventory screens show it: a batch of a food with its
 * own amount, date and location. `id` is the lot id, and `quantity` is in
 * `unit`, the food's stock unit ("g", "ml", or a count word such as "can").
 * `is_leftover` is true when the food is in the Leftovers category.
 */
export type InventoryItem = {
  id: string;
  food_id: string;
  name: string;
  quantity: number;
  unit: string;
  expiration_date: string | null;
  storage_location: "fridge" | "freezer" | "pantry";
  is_leftover: boolean;
  notes: string | null;
  added_by: string | null;
  category: Category | null;
};

type FoodRow = { id: string; name: string; category: Category | null } & (
  | { stock_base: "g" | "ml"; each_label: null }
  | { stock_base: "each"; each_label: string }
);

type LotRow = Pick<
  InventoryItem,
  "id" | "quantity" | "expiration_date" | "storage_location" | "notes" | "added_by"
> & { food: FoodRow };

const LEFTOVERS_CATEGORY = "Leftovers";

const SELECT = `
  id, quantity, expiration_date, storage_location, notes, added_by,
  food:food_stock!inner(id, name, stock_base, each_label, category:food_categories(id, name, icon))
` as const;

/**
 * Returns the household's live lots (not used up), soonest expiry first and
 * undated lots last, each joined with its food from the `food_stock` view.
 * Reads `lots` under the query key `['inventory', householdId]`, which every
 * inventory mutation invalidates. Waits until the household id is known.
 */
export function useInventoryItems() {
  const householdId = useAuthStore((s) => s.householdId);

  return useQuery({
    queryKey: ["inventory", householdId],
    enabled: !!householdId,
    queryFn: async (): Promise<InventoryItem[]> => {
      const { data, error } = await supabase
        .from("lots")
        .select(SELECT)
        .eq("household_id", householdId!)
        .is("depleted_at", null)
        .order("expiration_date", { ascending: true, nullsFirst: false });

      if (error) throw error;
      return ((data ?? []) as unknown as LotRow[]).map(toInventoryItem);
    },
  });
}

function toInventoryItem({ food, ...lot }: LotRow): InventoryItem {
  return {
    ...lot,
    food_id: food.id,
    name: food.name,
    unit: food.stock_base === "each" ? food.each_label : food.stock_base,
    is_leftover: food.category?.name === LEFTOVERS_CATEGORY,
    category: food.category,
  };
}

/**
 * Returns whole days from today to a `YYYY-MM-DD` date in local time, negative
 * once it has passed, or `null` when there is no date or it is malformed.
 */
export function daysUntilExpiration(expirationDate: string | null): number | null {
  if (!expirationDate) return null;
  const parts = expirationDate.split("-");
  if (parts.length !== 3) return null;
  const [y, m, d] = parts.map((p) => Number(p));
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return null;
  const exp = new Date(y, m - 1, d);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diffMs = exp.getTime() - today.getTime();
  return Math.round(diffMs / 86400000);
}
