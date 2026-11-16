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
 * `opened_at` is when the lot was first opened (`null` while sealed), and
 * `created_at` is when it was added; both are ISO timestamps.
 * `initial_quantity` is the lot's full size in `unit`, or `null` for a lot
 * backfilled from `inventory_items`, whose full size is unknown. `is_estimate` is
 * true when `quantity` was eyeballed, so it shows as "about". `updated_at` is
 * the lot's version, kept as the exact string the database sent so that
 * `set_lot_remaining` can compare it at full precision.
 * `whole_units_only` is true for foods counted in whole units, such as cans.
 */
export type InventoryItem = {
  id: string;
  food_id: string;
  name: string;
  quantity: number;
  initial_quantity: number | null;
  is_estimate: boolean;
  unit: string;
  whole_units_only: boolean;
  expiration_date: string | null;
  storage_location: "fridge" | "freezer" | "pantry";
  is_leftover: boolean;
  notes: string | null;
  added_by: string | null;
  opened_at: string | null;
  created_at: string;
  updated_at: string;
  category: Category | null;
};

type FoodRow = {
  id: string;
  name: string;
  whole_units_only: boolean;
  category: Category | null;
} & (
  | { stock_base: "g" | "ml"; each_label: null }
  | { stock_base: "each"; each_label: string }
);

type LotRow = Pick<
  InventoryItem,
  | "id"
  | "quantity"
  | "initial_quantity"
  | "is_estimate"
  | "expiration_date"
  | "storage_location"
  | "notes"
  | "added_by"
  | "opened_at"
  | "created_at"
  | "updated_at"
> & { food: FoodRow };

const LEFTOVERS_CATEGORY = "Leftovers";

const SELECT = `
  id, quantity, initial_quantity, is_estimate, expiration_date, storage_location, notes,
  added_by, opened_at, created_at, updated_at,
  food:food_stock!inner(id, name, stock_base, each_label, whole_units_only,
    category:food_categories(id, name, icon))
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
    whole_units_only: food.whole_units_only,
    is_leftover: food.category?.name === LEFTOVERS_CATEGORY,
    category: food.category,
  };
}
