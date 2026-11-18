import { useEffect, useState } from "react";
import { useLocalSearchParams, useRouter } from "expo-router";
import Toast from "@/lib/toast";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import CookChecklist from "@/components/cook-checklist";
import { RecipeView, cookFooterTop } from "@/components/recipe-detail";
import { ToastHost } from "@/components/toastConfig";
import { useActiveCook } from "@/hooks/useActiveCook";
import { useSavedRecipes } from "@/hooks/useSavedRecipes";
import type { RecipeSuggestion } from "@/types/recipes";

/**
 * The active cook's recipe, reachable from the "Cooking" banner after any
 * restart, and its done-cooking checklist. The `stage=checklist` param opens
 * the checklist first. The screen closes once the cook ends.
 */
export default function CookScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ stage?: string }>();
  const [stage, setStage] = useState<"recipe" | "checklist">(
    params.stage === "checklist" ? "checklist" : "recipe",
  );
  const insets = useSafeAreaInsets();
  const cook = useActiveCook();
  const saved = useSavedRecipes();
  const recipe = cook.activeCook?.recipe ?? null;

  useEffect(() => {
    if (recipe) return;
    if (router.canGoBack()) router.back();
    else router.replace("/");
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

  // iOS presents this fullScreenModal above the root view, which hides the
  // app-level toast host, so the screen mounts its own.
  return (
    <>
      {stage === "checklist" ? (
        <CookChecklist onBack={() => setStage("recipe")} />
      ) : (
        <RecipeView
          recipe={recipe}
          isSaved={saved.savedIds.has(recipe.recipe_id)}
          isSavePending={saved.isToggling}
          onToggleSave={toggleSave}
          onClose={() => router.back()}
          cooking
          cookPending={cook.pending}
          onCook={() => undefined}
          onDoneCooking={() => setStage("checklist")}
        />
      )}
      <ToastHost bottomInset={cookFooterTop(insets.bottom)} />
    </>
  );
}
