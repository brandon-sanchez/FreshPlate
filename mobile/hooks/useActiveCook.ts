import Toast from "react-native-toast-message";
import { useActiveCookStore } from "@/stores/activeCook";
import { useAuthStore } from "@/stores/auth";
import type { RecipeSuggestion } from "@/types/recipes";

/**
 * Returns the active cook, its `pending` flag, and `start` and `finish`
 * actions. Only one cook can be active at a time. Reads and writes
 * `useActiveCookStore`, which keeps the cook in AsyncStorage under the signed-in
 * user and household from `useAuthStore`.
 *
 * `start` resolves to `true` when the recipe is the active cook afterward. It
 * refuses a second recipe while another cook is active. `finish` clears the
 * cook without changing inventory and resolves to `true` when it succeeds.
 * Both show an error toast instead of throwing, so callers only branch on the
 * boolean.
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

  // TODO(#30): confirm the used amounts and deduct them from inventory before
  // clearing the cook.
  const finish = async (): Promise<boolean> => {
    try {
      await useActiveCookStore.getState().clear();
      return true;
    } catch {
      Toast.show({
        type: "error",
        text1: "Couldn't finish cooking",
        text2: "Try again in a moment.",
      });
      return false;
    }
  };

  return { activeCook, pending, start, finish };
}
