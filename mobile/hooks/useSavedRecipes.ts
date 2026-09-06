import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { useAuthStore } from "@/stores/auth";
import type { RecipeSuggestion } from "@/types/recipes";

export type SavedRecipe = {
  id: string;
  household_id: string;
  recipe_id: string;
  recipe: RecipeSuggestion;
  saved_by: string;
  created_at: string;
};

function isSavedRecipe(value: unknown): value is SavedRecipe {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return typeof row.id === "string" && typeof row.household_id === "string" &&
    typeof row.recipe_id === "string" && typeof row.saved_by === "string" &&
    typeof row.created_at === "string" && isRecipeSuggestion(row.recipe);
}

function isRecipeSuggestion(value: unknown): value is RecipeSuggestion {
  if (!value || typeof value !== "object") return false;
  const recipe = value as Record<string, unknown>;
  if (typeof recipe.recipe_id !== "string" || typeof recipe.title !== "string" ||
    !Number.isFinite(recipe.cook_time_minutes) || !Number.isFinite(recipe.servings) ||
    !Number.isFinite(recipe.match_percent) || !Array.isArray(recipe.ingredients) ||
    !Array.isArray(recipe.steps) || !Array.isArray(recipe.saves_expiring)) return false;
  return recipe.ingredients.every((item) => {
    if (!item || typeof item !== "object") return false;
    const ingredient = item as Record<string, unknown>;
    return typeof ingredient.name === "string" &&
      (ingredient.inventory_item_id === null || typeof ingredient.inventory_item_id === "string") &&
      Number.isFinite(ingredient.use_amount) && typeof ingredient.unit === "string";
  }) && recipe.steps.every((step) => typeof step === "string") &&
    recipe.saves_expiring.every((item) => typeof item === "string");
}

export function useSavedRecipes() {
  const householdId = useAuthStore((state) => state.householdId);
  const queryClient = useQueryClient();
  const queryKey = ["saved-recipes", householdId] as const;
  const query = useQuery({
    queryKey,
    enabled: !!householdId,
    queryFn: async (): Promise<SavedRecipe[]> => {
      if (!householdId) return [];
      const { data, error } = await supabase
        .from("saved_recipes")
        .select("id, household_id, recipe_id, recipe, saved_by, created_at")
        .eq("household_id", householdId)
        .order("created_at", { ascending: false });
      if (error) throw error;
      const rows: unknown[] = data ?? [];
      const validated = rows.filter(
        (row): row is SavedRecipe =>
          isSavedRecipe(row) && row.recipe.recipe_id === row.recipe_id,
      );
      if (validated.length !== rows.length) throw new Error("Invalid saved recipe response");
      return validated;
    },
  });

  const toggle = useMutation({
    mutationFn: async ({ recipe, saved, householdId: targetHouseholdId, userId }: { recipe: RecipeSuggestion; saved: boolean; householdId: string; userId: string }) => {
      if (saved) {
        const { error } = await supabase.from("saved_recipes").delete()
          .eq("household_id", targetHouseholdId).eq("recipe_id", recipe.recipe_id);
        if (error) throw error;
      } else {
        const { error } = await supabase.from("saved_recipes").insert({
          household_id: targetHouseholdId, recipe_id: recipe.recipe_id, recipe, saved_by: userId,
        });
        if (error) throw error;
      }
    },
    onSuccess: (_data, variables) => queryClient.invalidateQueries({ queryKey: ["saved-recipes", variables.householdId] }),
  });

  const savedIds = new Set((query.data ?? []).map((item) => item.recipe_id));
  const toggleSaved = ({ recipe, saved }: { recipe: RecipeSuggestion; saved: boolean }) => {
    const targetHouseholdId = useAuthStore.getState().householdId;
    const userId = useAuthStore.getState().user?.id;
    if (!targetHouseholdId || !userId) {
      toggle.reset();
      return Promise.reject(new Error("not signed in"));
    }
    return toggle.mutateAsync({ recipe, saved, householdId: targetHouseholdId, userId });
  };
  return { ...query, savedIds, toggle: toggleSaved, isToggling: toggle.isPending, toggleError: toggle.error };
}
