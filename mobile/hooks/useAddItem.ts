import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { ToastShowParams } from "@/lib/toast";
import { supabase } from "@/lib/supabase";
import { readStockUnit, toStockAmount } from "@/lib/stockUnit";
import { useAuthStore } from "@/stores/auth";

/** A batch of food to add, with the amount in the unit the user typed. */
export type AddItemInput = {
  name: string;
  category_id: string | null;
  quantity: number;
  unit: string;
  expiration_date: string | null;
  storage_location: "fridge" | "freezer" | "pantry";
  notes: string | null;
};

/**
 * The lot the batch landed in. `merged` is true when the amount joined an
 * identical full lot instead of starting a new one.
 */
export type AddItemResult = { id: string; merged: boolean };

/**
 * Thrown when the food already exists in a different stock unit, such as
 * adding "Milk, 1 can" when Milk is tracked in ml. Nothing is written.
 */
export class StockUnitMismatchError extends Error {
  /** The unit the food is tracked in: "g", "ml", or its count word ("can"). */
  readonly trackedUnit: string;

  constructor(trackedUnit: string) {
    super(`STOCK_BASE_MISMATCH: tracked in ${trackedUnit}`);
    this.name = "StockUnitMismatchError";
    this.trackedUnit = trackedUnit;
  }
}

const MISMATCH_DETAIL = /is stored as (g|ml|each)(?: \((.+)\))?$/;

/**
 * Returns a mutation that adds a batch of food through the `add_lot` RPC. The
 * typed unit is read into the food's stock base first ("1.5 kg" adds 1500 g).
 * The RPC creates the food when its name is new and merges the amount into a
 * full, unopened lot with the same date, location and note. Invalidates
 * `['inventory']` on success.
 *
 * @throws {@link StockUnitMismatchError} when the food is tracked in another
 * unit.
 */
export function useAddItem() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: AddItemInput): Promise<AddItemResult> => {
      const { user, householdId } = useAuthStore.getState();
      if (!user || !householdId) throw new Error("not signed in");

      const unit = readStockUnit(input.unit);
      const { data, error } = await supabase.rpc("add_lot", {
        p_household_id: householdId,
        p_name: input.name,
        p_stock_base: unit.stockBase,
        p_quantity: toStockAmount(input.quantity, unit),
        p_storage_location: input.storage_location,
        p_expiration_date: input.expiration_date,
        p_category_id: input.category_id,
        p_each_label: unit.eachLabel,
        p_notes: input.notes,
      });
      if (error) {
        const mismatch =
          error.message === "STOCK_BASE_MISMATCH"
            ? MISMATCH_DETAIL.exec(error.details ?? "")
            : null;
        if (mismatch)
          throw new StockUnitMismatchError(mismatch[2] ?? mismatch[1]);
        throw error;
      }
      const result = data as { lot_id: string; lot_merged: boolean };
      return { id: result.lot_id, merged: result.lot_merged };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["inventory"] });
    },
  });
}

/**
 * Returns the toast for a successful add: "Updated" when the amount joined an
 * existing lot, "Added" otherwise.
 *
 * @param result - The mutation's result.
 * @param name - The food name as typed.
 */
export function addItemSuccessToast(
  result: AddItemResult,
  name: string,
): ToastShowParams {
  return result.merged
    ? {
        type: "success",
        text1: `Updated ${name}`,
        text2: "Added to your existing item.",
      }
    : {
        type: "success",
        text1: `Added ${name}`,
        text2: "Tap to view in your inventory.",
      };
}

/**
 * Returns the toast for a failed add. A {@link StockUnitMismatchError} names
 * the unit the food is tracked in; any other error is treated as a network
 * failure.
 *
 * @param error - The mutation's error.
 * @param name - The food name as typed.
 */
export function addItemErrorToast(error: Error, name: string): ToastShowParams {
  if (error instanceof StockUnitMismatchError) {
    return {
      type: "error",
      text1: `Couldn't add ${name}`,
      text2: `It's tracked in ${error.trackedUnit}. Add it in that unit.`,
    };
  }
  return {
    type: "error",
    text1: "Couldn't save",
    text2: "Check your connection and try again.",
  };
}
