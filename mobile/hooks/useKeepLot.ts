import { useMutation, useQueryClient } from "@tanstack/react-query";
import Toast from "react-native-toast-message";
import { supabase } from "@/lib/supabase";
import { lotErrorToast, requireLiveLot } from "@/lib/lotRpc";
import { formatShortDate } from "@/lib/expiry";

type KeepInput = {
  id: string;
  /** The food's name, shown in the toast. */
  name: string;
  /** The batch's new expiration date, as `YYYY-MM-DD`. */
  expirationDate: string;
};

/**
 * Returns a mutation that marks an expired batch "Still good" by giving the
 * lot a new expiration date in `lots`, which returns it to available stock.
 * Members may write a lot's date directly. Quantity changes go through RPCs.
 *
 * Shows a "kept" toast with the new date on success. Fails with
 * `ChangedElsewhereError` and an "already changed" toast when the lot is
 * not live, because another phone tossed or used it up first.
 * Invalidates `['inventory']` when it settles.
 */
export function useKeepLot() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ id, expirationDate }: KeepInput) =>
      requireLiveLot(
        await supabase
          .from("lots")
          .update({ expiration_date: expirationDate })
          .eq("id", id)
          .is("depleted_at", null)
          .select("id"),
      ),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["inventory"] }),
    onSuccess: (_data, { name, expirationDate }) =>
      Toast.show({
        type: "success",
        text1: `${name} kept`,
        text2: `Good until ${formatShortDate(expirationDate)}`,
      }),
    onError: (error, { name }) => Toast.show(lotErrorToast(name, error)),
  });
}

