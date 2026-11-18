import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useFoodStock } from "@/hooks/useFoodStock";
import { useFoodSubUnits } from "@/hooks/useFoodSubUnits";
import { ApiError } from "@/lib/api";
import { confirmCook, fetchCookPlan } from "@/lib/cook-api";
import {
  addedLine,
  confirmationBody,
  linesFromPlan,
  reloadLines,
  type AddableFood,
  type ChecklistLine,
} from "@/lib/cook-checklist";
import Toast from "@/lib/toast";
import { useActiveCookStore } from "@/stores/activeCook";
import type { UntrackedIngredient } from "@/types/cook";
import type { RecipeSuggestion } from "@/types/recipes";

const STOCK_CHANGED = "STOCK_CHANGED";
// The operation already recorded a cook, so an earlier attempt whose
// response was lost went through.
const COOK_ALREADY_CONFIRMED = "COOK_ALREADY_CONFIRMED";

/**
 * Runs the done-cooking checklist for the active cook from
 * `useActiveCookStore`.
 *
 * Plans the recipe with `POST /api/cook/plan` under the query key
 * `['cook-plan', householdId, operationId]`, and reads the household's foods
 * with unexpired stock through {@link useFoodStock} for "Add item" and their
 * smaller units through {@link useFoodSubUnits}. Keeps the person's amounts
 * locally. `confirm` sends them to `POST /api/cook/confirm`. On
 * success, or when the cook was already confirmed, it invalidates
 * `['inventory']`, passes the cooked recipe to `onConfirmed` and clears the
 * active cook. On `STOCK_CHANGED` it refetches both queries, marks the lines
 * whose stock fell, and keeps the cook. Any other failure shows an error
 * toast and keeps the cook.
 *
 * @param onConfirmed - Receives the cooked recipe before the active cook is
 *   cleared, so the caller can keep showing it.
 */
export function useCookChecklist({
  onConfirmed,
}: {
  onConfirmed: (recipe: RecipeSuggestion) => void;
}) {
  const queryClient = useQueryClient();
  const cook = useActiveCookStore((s) => s.activeCook);
  const householdId = cook?.householdId;
  const plan = useQuery({
    queryKey: ["cook-plan", householdId, cook?.operationId],
    enabled: cook !== null,
    staleTime: Infinity,
    queryFn: () =>
      fetchCookPlan({
        household_id: cook!.householdId,
        ingredients: cook!.recipe.ingredients,
      }),
  });
  const stock = useFoodStock();
  const subUnits = useFoodSubUnits();
  const [edited, setEdited] = useState<ChecklistLine[] | null>(null);
  const [stockChanged, setStockChanged] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const planned = plan.data ? linesFromPlan(plan.data) : [];
  const withSubUnit = <T extends AddableFood>(food: T): T => ({
    ...food,
    subUnit: subUnits[food.foodId] ?? null,
  });
  const lines = (edited ?? planned).map(withSubUnit);
  const untracked: UntrackedIngredient[] = plan.data?.untracked ?? [];
  const update = (change: (current: ChecklistLine[]) => ChecklistLine[]) =>
    setEdited((current) => change((current ?? planned).map(withSubUnit)));

  const setAmount = (foodId: string, amount: number) =>
    update((current) =>
      current.map((line) =>
        line.foodId === foodId ? { ...line, amount, changed: null } : line,
      ),
    );
  const addFood = (food: AddableFood) =>
    update((current) => [...current, addedLine(food)]);
  const removeFood = (foodId: string) =>
    update((current) => current.filter((line) => line.foodId !== foodId));

  /** Marks the lines whose stock fell. Returns `false` when stock can't be read. */
  const reload = async (): Promise<boolean> => {
    const [freshPlan, freshStock] = await Promise.all([
      plan.refetch(),
      stock.refetch(),
    ]);
    if (freshPlan.isError || freshStock.isError || !freshPlan.data) return false;
    const available = new Map(
      (freshStock.data ?? []).map((food) => [food.foodId, food.available]),
    );
    update((current) => reloadLines(current, freshPlan.data, available));
    return true;
  };

  const finish = async (recipe: RecipeSuggestion) => {
    setStockChanged(false);
    void queryClient.invalidateQueries({ queryKey: ["inventory"] });
    onConfirmed(recipe);
    // The kitchen is already updated, so a failed clear only leaves the cook
    // showing until the next confirm, which the server answers as already
    // confirmed.
    await useActiveCookStore
      .getState()
      .clear()
      .catch(() => undefined);
  };

  const confirm = async (): Promise<void> => {
    if (!cook) return;
    setConfirming(true);
    try {
      await confirmCook(confirmationBody(cook, lines));
      await finish(cook.recipe);
    } catch (error) {
      const code = error instanceof ApiError ? error.code : null;
      if (code === COOK_ALREADY_CONFIRMED) {
        await finish(cook.recipe);
      } else if (code === STOCK_CHANGED && (await reload())) {
        setStockChanged(true);
      } else {
        Toast.show({
          type: "error",
          text1: "Couldn't update your kitchen",
          text2: "Check your connection and try again.",
        });
      }
    } finally {
      setConfirming(false);
    }
  };

  return {
    cook,
    status: plan.isPending ? "loading" : plan.isError ? "error" : "ready",
    lines,
    untracked,
    addable: (stock.data ?? []).map(withSubUnit),
    stockChanged,
    confirming,
    retry: () => void plan.refetch(),
    setAmount,
    addFood,
    removeFood,
    confirm,
  } as const;
}
