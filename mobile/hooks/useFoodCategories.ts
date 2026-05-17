import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";

export type FoodCategory = {
  id: string;
  name: string;
  default_shelf_life_days: number | null;
  icon: string | null;
};

export function useFoodCategories() {
  return useQuery({
    queryKey: ["food_categories"],
    queryFn: async (): Promise<FoodCategory[]> => {
      const { data, error } = await supabase
        .from("food_categories")
        .select("id, name, default_shelf_life_days, icon");

      if (error) throw error;

      return data;
    },
  });
}
