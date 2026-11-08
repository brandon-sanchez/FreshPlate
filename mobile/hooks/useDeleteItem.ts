import { useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";

/**
 * Returns a mutation that erases a lot by id and invalidates `['inventory']`
 * on success. Members may delete their own household's live lots; a used-up
 * or tossed lot is history and the database keeps it. The delete leaves no
 * trace, so it is only for a batch added by mistake. Recording that food was
 * eaten or thrown out goes through `useLotOutcome`.
 */
export function useDeleteItem() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("lots").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["inventory"] });
    },
  });
}
