import { useMutation, useQueryClient } from "@tanstack/react-query";
import Toast from "react-native-toast-message";
import { supabase } from "@/lib/supabase";
import { ChangedElsewhereError, RETRY_HINT, lotErrorToast, requireLiveLot } from "@/lib/lotRpc";

type DeleteInput = {
  id: string;
  /** The food's name, shown in the toast. */
  name: string;
};

/**
 * Returns a mutation that erases a lot by id. Members may delete their own
 * household's live lots; a used-up or tossed lot is history and the database
 * keeps it. The delete leaves no trace, so it is only for a batch added by
 * mistake. Recording that food was eaten or thrown out goes through
 * `useLotOutcome`.
 *
 * Shows a "Deleted" toast on success. Fails with
 * {@link ChangedElsewhereError} and an "already changed" toast when no row
 * matched, because another phone deleted the lot or marked it used up or
 * tossed first. Invalidates `['inventory']` when it settles, so a refused
 * delete also refreshes the list.
 */
export function useDeleteItem() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ id }: DeleteInput) => {
      // The delete policy matches only live lots, so a depleted lot comes
      // back as no row.
      requireLiveLot(await supabase.from("lots").delete().eq("id", id).select("id"));
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["inventory"] }),
    onSuccess: () => Toast.show({ type: "success", text1: "Deleted" }),
    onError: (error, { name }) =>
      Toast.show(
        error instanceof ChangedElsewhereError
          ? lotErrorToast(name, error)
          : { type: "error", text1: "Couldn't delete", text2: RETRY_HINT },
      ),
  });
}
