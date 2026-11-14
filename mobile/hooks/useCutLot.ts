import { useMutation, useQueryClient } from "@tanstack/react-query";
import Toast from "react-native-toast-message";
import type { InventoryItem } from "@/hooks/useInventoryItems";
import { callLotRpc, lotErrorToast } from "@/lib/lotRpc";
import { useAuthStore } from "@/stores/auth";

type CutLotInput = {
  /** The batch to cut from, with the name for the toast. */
  lot: Pick<InventoryItem, "id" | "name">;
  /** How much to cut, in the food's stock unit, at most the batch's amount. */
  quantity: number;
  /**
   * The cut part's date as `YYYY-MM-DD`, or `null` to keep the batch's. The
   * database never lets it be later than the batch's date.
   */
  expirationDate: string | null;
};

const STALE_CODES = ["LOT_NOT_LIVE", "NOT_ENOUGH_LEFT"] as const;

/**
 * Returns a mutation that cuts part of a batch into its own opened batch
 * through the `cut_lot` RPC, so cooking draws from it first. The food's total
 * stays the same. Cutting the whole amount opens the batch in place.
 * Invalidates `['inventory']` when it settles, success or not. A failure shows
 * an error toast that says whether the batch changed elsewhere or the
 * connection failed. Reads the household id from the auth store.
 */
export function useCutLot() {
  const queryClient = useQueryClient();
  const householdId = useAuthStore((s) => s.householdId);

  return useMutation({
    mutationFn: ({ lot, quantity, expirationDate }: CutLotInput) =>
      callLotRpc(
        "cut_lot",
        {
          p_household_id: householdId,
          p_lot_id: lot.id,
          p_quantity: quantity,
          p_expiration_date: expirationDate,
        },
        STALE_CODES,
      ),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["inventory"] }),
    onError: (error, { lot }) => Toast.show(lotErrorToast(lot.name, error)),
  });
}
