import { useMutation, useQueryClient } from "@tanstack/react-query";
import Toast from "react-native-toast-message";
import type { InventoryItem } from "@/hooks/useInventoryItems";
import { callLotRpc, lotErrorToast } from "@/lib/lotRpc";
import { useAuthStore } from "@/stores/auth";

type SetRemainingInput = {
  /** The batch, carrying the `updated_at` the screen last read and the name for the toast. */
  lot: Pick<InventoryItem, "id" | "updated_at" | "name">;
  /**
   * How much is left: a share of the batch's full size (`fraction`, 1 for
   * Full) or an exact amount in the food's stock unit (`quantity`).
   */
  remaining: { fraction: number } | { quantity: number };
};

// FULL_SIZE_UNKNOWN means the screen offered fill levels from an out-of-date
// copy of the batch, so it reads as a change made elsewhere.
const STALE_CODES = ["STALE", "LOT_NOT_LIVE", "FULL_SIZE_UNKNOWN"] as const;

/**
 * Returns a mutation that sets how much of a batch is left through the
 * `set_lot_remaining` RPC. It sends the batch's last-read `updated_at`, so the
 * database refuses the write if a cook or another phone changed the batch
 * first. Stays pending until `['inventory']` has refetched, so the next set
 * sends the fresh `updated_at`. The refetch also runs after a refusal, so the
 * screen shows the other phone's amount. A failure shows an error toast that
 * says whether the batch changed elsewhere or the connection failed. Reads the
 * household id from the auth store.
 */
export function useSetLotRemaining() {
  const queryClient = useQueryClient();
  const householdId = useAuthStore((s) => s.householdId);

  return useMutation({
    mutationFn: ({ lot, remaining }: SetRemainingInput) =>
      callLotRpc(
        "set_lot_remaining",
        {
          p_household_id: householdId,
          p_lot_id: lot.id,
          p_seen_updated_at: lot.updated_at,
          p_fraction: "fraction" in remaining ? remaining.fraction : null,
          p_quantity: "quantity" in remaining ? remaining.quantity : null,
        },
        STALE_CODES,
      ),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["inventory"] }),
    onError: (error, { lot }) => Toast.show(lotErrorToast(lot.name, error)),
  });
}
