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

export type AddItemResult = { id: string; merged: boolean };

/* On merge, the earlier expiration wins so the soonest-perishable batch
 * drives the combined row's urgency. */
function earlierDate(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return a < b ? a : b;
}

export function useAddItem() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: AddItemInput): Promise<AddItemResult> => {
      const { user, householdId } = useAuthStore.getState();
      if (!user || !householdId) throw new Error("not signed in");

      /* Match key for "same batch": household + name (case-insensitive) +
       * storage + unit + category + expiration_date. Different expirations
       * stay as separate rows so each batch has its own urgency clock. */
      const trimmedName = input.name.trim();
      let lookup = supabase
        .from("inventory_items")
        .select("id, quantity, expiration_date")
        .eq("household_id", householdId)
        .ilike("name", trimmedName)
        .eq("storage_location", input.storage_location)
        .eq("unit", input.unit);
      lookup =
        input.category_id === null
          ? lookup.is("category_id", null)
          : lookup.eq("category_id", input.category_id);
      lookup =
        input.expiration_date === null
          ? lookup.is("expiration_date", null)
          : lookup.eq("expiration_date", input.expiration_date);

      const { data: existing, error: lookupError } = await lookup
        .limit(1)
        .maybeSingle();

      if (lookupError) throw lookupError;

      if (existing) {
        const mergedQuantity = existing.quantity + input.quantity;
        const mergedExpiration = earlierDate(
          existing.expiration_date,
          input.expiration_date,
        );
        const { data, error } = await supabase
          .from("inventory_items")
          .update({
            quantity: mergedQuantity,
            expiration_date: mergedExpiration,
          })
          .eq("id", existing.id)
          .select("id")
          .single();
        if (error) throw error;
        return { id: data.id, merged: true };
      }

      const payload = {
        ...input,
        name: trimmedName,
        household_id: householdId,
        added_by: user.id,
      };
      const { data, error } = await supabase
        .from("inventory_items")
        .insert(payload)
        .select("id")
        .single();
      if (error) throw error;
      return { id: data.id, merged: false };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["inventory"] });
    },
  });
}
