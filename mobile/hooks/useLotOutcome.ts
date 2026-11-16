import { useMutation, useQueryClient } from "@tanstack/react-query";
import Toast from "react-native-toast-message";
import { ChangedElsewhereError, RETRY_HINT, callLotRpc, lotErrorToast } from "@/lib/lotRpc";
import { showUndoToast } from "@/components/toastConfig";
import { useAuthStore } from "@/stores/auth";

/** What happened to a batch of food: eaten (`used`) or thrown out (`tossed`). */
export type LotOutcome = "used" | "tossed";

type RecordInput = {
  lotIds: string[];
  outcome: LotOutcome;
  /** The food's name, shown in the toast. */
  name: string;
};

/**
 * Returns `record`, which marks batches of one food as used up or tossed
 * through the `deplete_lots` RPC. The amounts stay on the batches for waste
 * history.
 *
 * After a record succeeds, an undo toast offers to put the batches back
 * through `restore_lots`. Both RPCs invalidate `['inventory']` when they
 * settle, so a refused call also refreshes a list that another phone changed.
 * A failure shows an error toast that says whether another phone got there
 * first or the connection failed. Reads the household id from the auth store.
 */
export function useLotOutcome() {
  const queryClient = useQueryClient();
  const householdId = useAuthStore((s) => s.householdId);
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["inventory"] });

  // Toasts live in the mutation options, not in mutate() callbacks, because
  // TanStack Query skips mutate() callbacks once the calling component
  // unmounts, and a row unmounts as soon as its batches are recorded.
  const restore = useMutation({
    mutationFn: (lotIds: string[]) =>
      callLotRpc(
        "restore_lots",
        { p_household_id: householdId, p_lot_ids: lotIds },
        ["LOT_NOT_RESTORABLE"],
      ),
    onSettled: invalidate,
    onSuccess: () => Toast.show({ type: "success", text1: "Restored" }),
    onError: (error) =>
      Toast.show({
        type: "error",
        text1: "Couldn't undo",
        text2:
          error instanceof ChangedElsewhereError ? "It was changed on another phone." : RETRY_HINT,
      }),
  });

  const deplete = useMutation({
    mutationFn: ({ lotIds, outcome }: RecordInput) =>
      callLotRpc(
        "deplete_lots",
        { p_household_id: householdId, p_lot_ids: lotIds, p_reason: outcome },
        ["LOT_NOT_LIVE"],
      ),
    onSettled: invalidate,
    onSuccess: (_data, { lotIds, outcome, name }) =>
      showUndoToast({
        text1: outcome === "used" ? `${name} used up` : `${name} tossed`,
        text2: lotIds.length > 1 ? `${lotIds.length} batches` : undefined,
        onUndo: () => restore.mutate(lotIds),
      }),
    onError: (error, { name }) => Toast.show(lotErrorToast(name, error)),
  });

  /**
   * Records what happened to the given batches.
   *
   * @param input - The batches' lot ids, what happened to them, and the food name for the toast.
   * @param onError - Runs when the record fails, so the caller can let the user try again.
   */
  const record = (input: RecordInput, onError: () => void) =>
    deplete.mutate(input, { onError });

  return { record };
}
