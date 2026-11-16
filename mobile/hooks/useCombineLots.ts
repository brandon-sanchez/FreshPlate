import { useMutation, useQueryClient } from "@tanstack/react-query";
import Toast from "react-native-toast-message";
import { callLotRpc, lotErrorToast } from "@/lib/lotRpc";
import { useAuthStore } from "@/stores/auth";

type CombineLotsInput = {
  /** The food's name, for the error toast. */
  name: string;
  /** The batch that holds the mix and keeps its location and notes. */
  intoLotId: string;
  /** The batches of the same food poured into it, at least one. */
  lotIds: readonly string[];
};

/**
 * Returns a mutation that combines batches of one food that were physically
 * mixed through the `combine_lots` RPC. The result holds the sum of the
 * amounts, counts as opened and takes the earliest date. Invalidates
 * `['inventory']` when it settles, success or not. A failure shows an error
 * toast that says whether a batch changed elsewhere or the connection failed.
 * Reads the household id from the auth store.
 */
export function useCombineLots() {
  const queryClient = useQueryClient();
  const householdId = useAuthStore((s) => s.householdId);

  return useMutation({
    mutationFn: ({ intoLotId, lotIds }: CombineLotsInput) =>
      callLotRpc(
        "combine_lots",
        { p_household_id: householdId, p_into_lot_id: intoLotId, p_lot_ids: lotIds },
        ["LOT_NOT_LIVE"],
      ),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["inventory"] }),
    onError: (error, { name }) => Toast.show(lotErrorToast(name, error)),
  });
}
