import Toast from "@/lib/toast";
import { useActiveCookStore } from "@/stores/activeCook";
import { useAuthStore } from "@/stores/auth";
import type { RecipeSuggestion } from "@/types/recipes";

/**
 * Returns the active cook, its `pending` flag, and a `start` action. Only one
 * cook can be active at a time. Reads and writes
 * `useActiveCookStore`, which keeps the cook in AsyncStorage under the signed-in
 * user and household from `useAuthStore`.
 *
 * `start` resolves to `true` when the recipe is the active cook afterward. It
 * refuses a second recipe while another cook is active, and shows an error
 * toast instead of throwing, so callers only branch on the boolean. The
 * done-cooking checklist (`useCookChecklist`) ends the cook.
 */
export function useActiveCook() {
  const activeCook = useActiveCookStore((s) => s.activeCook);
  const pending = useActiveCookStore((s) => s.pending);
  const userId = useAuthStore((s) => s.user?.id ?? null);
  const householdId = useAuthStore((s) => s.householdId);

  const start = async (recipe: RecipeSuggestion): Promise<boolean> => {
    const current = useActiveCookStore.getState().activeCook;
    if (current && current.recipe.recipe_id !== recipe.recipe_id) {
      Toast.show({
        type: "error",
        text1: "Finish your current cook first",
        text2: `You're still cooking ${current.recipe.title}.`,
      });
      return false;
    }
    if (!userId || !householdId) return false;
    try {
      await useActiveCookStore.getState().start(userId, householdId, recipe);
      return true;
    } catch {
      Toast.show({
        type: "error",
        text1: "Couldn't start cooking",
        text2: "Try again in a moment.",
      });
      return false;
    }
  };

  return { activeCook, pending, start };
}

/**
 * Returns whether `recipeId` is the active cook's recipe. Reads
 * `useActiveCookStore` and rerenders when the active cook changes. An
 * undefined `recipeId` returns `false`.
 */
export function useIsActiveCook(recipeId: string | undefined): boolean {
  return useActiveCookStore(
    (s) => recipeId !== undefined && s.activeCook?.recipe.recipe_id === recipeId,
  );
}
