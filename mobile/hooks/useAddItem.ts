import { useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { useAuthStore } from "@/stores/auth";

export type AddItemInput = {
  name: string;
  category_id: string | null;
  quantity: number;
  unit: string;
  expiration_date: string | null;
  storage_location: "fridge" | "freezer" | "pantry";
  notes: string | null;
};

export function useAddItem() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: AddItemInput): Promise<{ id: string }> => {
      const { user, householdId } = useAuthStore.getState();
      if (!user || !householdId) throw new Error("not signed in");

      const payload = { ...input, household_id: householdId, added_by: user.id };

      const { data, error } = await supabase
        .from("inventory_items")
        .insert(payload)
        .select("id")
        .single();

      if (error) throw error;
      return { id: data.id };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["inventory"] });
    },
  });
}
