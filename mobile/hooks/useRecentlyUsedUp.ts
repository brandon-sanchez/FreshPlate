import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import Toast from "@/lib/toast";
import { callLotRpc, lotErrorToast } from "@/lib/lotRpc";
import { useAuthStore } from "@/stores/auth";
import type { StockBase } from "@/types/cook";

/**
 * A food the household ran out of in the last 14 days. `lotId` is its most
 * recently used-up batch, the one a restore brings back. `unit` is the food's
 * stock unit ("g", "ml", or a count word such as "egg"). `depletedAt` is an
 * ISO timestamp.
 */
export type UsedUpFood = {
  lotId: string;
  foodId: string;
  name: string;
  unit: string;
  wholeUnitsOnly: boolean;
  depletedAt: string;
};

type UsedUpRow = {
  lot_id: string;
  food_id: string;
  name: string;
  stock_base: StockBase;
  each_label: string | null;
  whole_units_only: boolean;
  depleted_at: string;
};

type RestoreInput = { food: UsedUpFood; quantity: number };

/**
 * Returns the household's recently used-up foods, most recent first, from the
 * `recently_used_up` view. Reads under `['inventory', householdId,
 * 'used-up']`, so every inventory mutation's `['inventory']` invalidation
 * refreshes the list. Waits until the household id is known.
 */
export function useRecentlyUsedUp() {
  const householdId = useAuthStore((s) => s.householdId);
  return useQuery({
    queryKey: ["inventory", householdId, "used-up"],
    enabled: !!householdId,
    queryFn: async (): Promise<UsedUpFood[]> => {
      const { data, error } = await supabase
        .from("recently_used_up")
        .select("lot_id, food_id, name, stock_base, each_label, whole_units_only, depleted_at")
        .eq("household_id", householdId!)
        .order("depleted_at", { ascending: false });
      if (error) throw error;
      return ((data ?? []) as UsedUpRow[]).map(toUsedUpFood);
    },
  });
}

/**
 * Returns a mutation that brings a used-up food back with the amount the
 * person says is left, through the `restore_used_up_lot` RPC. Takes
 * `{ food, quantity }`, with `quantity` in `food.unit`.
 *
 * Success refetches `['inventory']`, shows a success toast, then passes the
 * restored lot id to `onRestored`. Failure shows an error toast that says
 * whether another phone changed the food first, and refetches `['inventory']`.
 * Reads the household id from the auth store.
 *
 * @param onRestored - Runs from the mutation options, so it still runs after
 *   the refetch drops the row that started the restore.
 */
export function useRestoreUsedUp({ onRestored }: { onRestored: (lotId: string) => void }) {
  const queryClient = useQueryClient();
  const householdId = useAuthStore((s) => s.householdId);
  const refetchInventory = () => queryClient.invalidateQueries({ queryKey: ["inventory"] });

  return useMutation({
    mutationFn: ({ food, quantity }: RestoreInput) =>
      callLotRpc(
        "restore_used_up_lot",
        { p_household_id: householdId, p_lot_id: food.lotId, p_quantity: quantity },
        ["LOT_NOT_RESTORABLE"],
      ),
    // Awaited, so the inventory highlight starts once the restored row exists.
    onSuccess: async (_data, { food }) => {
      await refetchInventory();
      Toast.show({ type: "success", text1: `${food.name} restored` });
      onRestored(food.lotId);
    },
    onError: (error, { food }) => {
      Toast.show(lotErrorToast(food.name, error));
      void refetchInventory();
    },
  });
}

function toUsedUpFood(row: UsedUpRow): UsedUpFood {
  return {
    lotId: row.lot_id,
    foodId: row.food_id,
    name: row.name,
    unit: row.each_label ?? row.stock_base,
    wholeUnitsOnly: row.whole_units_only,
    depletedAt: row.depleted_at,
  };
}
