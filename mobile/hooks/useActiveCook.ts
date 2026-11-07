import Toast from "react-native-toast-message";
import { useActiveCookStore } from "@/stores/activeCook";
import { useAuthStore } from "@/stores/auth";
import type { RecipeSuggestion } from "@/types/recipes";

/**
 * Access to the single active cook. Starting is scoped to the
 * signed-in user and household; failures surface as toasts so callers only
 * branch on whether the cook is now active.
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

  // Ends the cook without touching inventory. The done-cooking checklist (#30)
  // replaces this with confirmation and deduction.
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
