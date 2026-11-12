import { useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";

/**
 * The lot to edit, its food, and only the fields that changed. `name` belongs
 * to the food, so renaming one lot renames every lot of that food.
 */
export type UpdateItemInput = {
  id: string;
  foodId: string;
  patch: {
    name?: string;
    quantity?: number;
    expiration_date?: string | null;
    storage_location?: "fridge" | "freezer" | "pantry";
    notes?: string | null;
  };
};

/**
 * Thrown when a rename would give the food the same name as another food in
 * the household. Nothing is written.
 */
export class FoodNameTakenError extends Error {
  constructor(name: string) {
    super(`A food named ${name} already exists`);
    this.name = "FoodNameTakenError";
  }
}

// Postgres unique_violation, raised by the UNIQUE (household_id, name_key) key
// on foods.
const UNIQUE_VIOLATION = "23505";

/**
 * Returns a mutation that saves edits to one lot. A changed name goes to
 * `foods` first, then date, location, notes and quantity go to `lots` in one
 * update. The two writes are separate requests, so a failed lot update leaves
 * a rename saved. The database lets members change a lot's date, location and
 * notes and a food's name; it rejects a quantity change, so that save fails.
 * A lot has no unit of its own: it is the food's stock unit. Invalidates
 * `['inventory']` on success.
 *
 * @throws {@link FoodNameTakenError} when another food already has the name.
 */
export function useUpdateItem() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ id, foodId, patch }: UpdateItemInput) => {
      const { name, ...lotPatch } = patch;

      if (name !== undefined) {
        const { error } = await supabase.from("foods").update({ name }).eq("id", foodId);
        if (error?.code === UNIQUE_VIOLATION) throw new FoodNameTakenError(name);
        if (error) throw error;
      }
      if (Object.keys(lotPatch).length > 0) {
        const { error } = await supabase.from("lots").update(lotPatch).eq("id", id);
        if (error) throw error;
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["inventory"] });
    },
  });
}
