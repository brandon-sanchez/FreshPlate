import { useEffect } from "react";
import { useRouter } from "expo-router";
import Toast from "react-native-toast-message";
import { RecipeView } from "@/components/recipe-detail";
import { useActiveCook } from "@/hooks/useActiveCook";
import { useSavedRecipes } from "@/hooks/useSavedRecipes";
import type { RecipeSuggestion } from "@/types/recipes";

/** The active cook's recipe, reachable from the "Cooking" banner after any restart. */
export default function CookScreen() {
  const router = useRouter();
  const cook = useActiveCook();
  const saved = useSavedRecipes();
  const recipe = cook.activeCook?.recipe ?? null;

  useEffect(() => {
    if (!recipe && router.canGoBack()) router.back();
  }, [recipe, router]);

  if (!recipe) return null;

  const toggleSave = (target: RecipeSuggestion, isSaved: boolean) => {
    void saved.toggle({ recipe: target, saved: isSaved }).catch(() => {
      Toast.show({
        type: "error",
        text1: "Couldn't update saved recipes",
        text2: "Check your connection and try again.",
      });
    });
  };

  return (
    <RecipeView
      recipe={recipe}
      isSaved={saved.savedIds.has(recipe.recipe_id)}
      isSavePending={saved.isToggling}
      onToggleSave={toggleSave}
      onClose={() => router.back()}
      cooking
      cookPending={cook.pending}
      onCook={() => undefined}
      onDoneCooking={() => void cook.finish()}
    />
  );
}
