import { useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";

export type UpdateItemInput = {
  id: string;
  patch: {
    name?: string;
    quantity?: number;
    unit?: string;
    expiration_date?: string | null;
    storage_location?: "fridge" | "freezer" | "pantry";
    notes?: string | null;
    category_id?: string | null;
  };
};

export function useUpdateItem() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ id, patch }: UpdateItemInput) => {
      const { error } = await supabase
        .from("inventory_items")
        .update(patch)
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["inventory"] });
    },
  });
}
