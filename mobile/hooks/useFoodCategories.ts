import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";

export type StorageLocation = "fridge" | "freezer" | "pantry";

export type FoodCategory = {
  id: string;
  name: string;
  default_shelf_life_days: number | null;
  icon: string | null;
  fridge_days: number | null;
  freezer_days: number | null;
  pantry_days: number | null;
};

export function useFoodCategories() {
  return useQuery({
    queryKey: ["food_categories"],
    queryFn: async (): Promise<FoodCategory[]> => {
      const { data, error } = await supabase
        .from("food_categories")
        .select(
          "id, name, default_shelf_life_days, icon, fridge_days, freezer_days, pantry_days",
        );

      if (error) throw error;

      return data;
    },
  });
}

/**
 * Look up the USDA-default shelf life for a (category, storage) pair. Returns null
 * when the combination isn't recommended (e.g., raw meat in pantry).
 */
export function shelfLifeFor(
  category: FoodCategory | null | undefined,
  storage: StorageLocation,
): number | null {
  if (!category) return null;
  if (storage === "fridge") return category.fridge_days;
  if (storage === "freezer") return category.freezer_days;
  return category.pantry_days;
}
