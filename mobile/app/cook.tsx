import { type ReactNode, useEffect, useState } from "react";
import { useLocalSearchParams, useRouter } from "expo-router";
import Toast from "@/lib/toast";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import CookChecklist from "@/components/cook-checklist";
import CookSuccess from "@/components/cook-success";
import { RecipeView, cookFooterTop } from "@/components/recipe-detail";
import { ToastHost } from "@/components/toastConfig";
import { useActiveCook } from "@/hooks/useActiveCook";
import { useSavedRecipes } from "@/hooks/useSavedRecipes";
import type { RecipeSuggestion } from "@/types/recipes";

/**
 * The active cook's recipe, reachable from the "Cooking" banner after any
 * restart, its done-cooking checklist, and the success screen after the cook
 * is confirmed. The `stage=checklist` param opens the checklist first. The
 * success screen offers to save the recipe, then goes to Inventory, where the
 * deducted stock shows. The screen closes if the cook ends any other way.
 */
type Stage =
  | { kind: "recipe" }
  | { kind: "checklist" }
  // Holds the recipe because confirming clears the active cook.
  | { kind: "done"; recipe: RecipeSuggestion };

export default function CookScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ stage?: string }>();
  const [stage, setStage] = useState<Stage>({
    kind: params.stage === "checklist" ? "checklist" : "recipe",
  });
  const insets = useSafeAreaInsets();
  const cook = useActiveCook();
  const saved = useSavedRecipes();
  const recipe = cook.activeCook?.recipe ?? null;

  useEffect(() => {
    if (recipe || stage.kind === "done") return;
    if (router.canGoBack()) router.back();
    else router.replace("/");
  }, [recipe, stage.kind, router]);

  const toggleSave = (target: RecipeSuggestion, isSaved: boolean) => {
    void saved.toggle({ recipe: target, saved: isSaved }).catch(() => {
      Toast.show({
        type: "error",
        text1: "Couldn't update saved recipes",
        text2: "Check your connection and try again.",
      });
    });
  };

  let content: ReactNode;
  if (stage.kind === "done") {
    content = (
      <CookSuccess
        isSaved={saved.savedIds.has(stage.recipe.recipe_id)}
        isSaving={saved.isToggling}
        onSave={() => toggleSave(stage.recipe, false)}
        onDone={() => router.dismissTo("/(tabs)/inventory")}
      />
    );
  } else if (!recipe) {
    return null;
  } else if (stage.kind === "checklist") {
    content = (
      <CookChecklist
        onBack={() => setStage({ kind: "recipe" })}
        onConfirmed={(confirmed) => setStage({ kind: "done", recipe: confirmed })}
      />
    );
  } else {
    content = (
      <RecipeView
        recipe={recipe}
        isSaved={saved.savedIds.has(recipe.recipe_id)}
        isSavePending={saved.isToggling}
        onToggleSave={toggleSave}
        onClose={() => router.back()}
        cooking
        cookPending={cook.pending}
        onCook={() => undefined}
        onDoneCooking={() => setStage({ kind: "checklist" })}
      />
    );
  }

  // iOS presents this fullScreenModal above the root view, which hides the
  // app-level toast host, so the screen mounts its own.
  return (
    <>
      {content}
      <ToastHost bottomInset={cookFooterTop(insets.bottom)} />
    </>
  );
}
