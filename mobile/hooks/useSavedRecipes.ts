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

export function useSavedRecipes() {
  const householdId = useAuthStore((state) => state.householdId);
  const queryClient = useQueryClient();
  const queryKey = ["saved-recipes", householdId] as const;
  const query = useQuery({
    queryKey,
    enabled: !!householdId,
    queryFn: async (): Promise<SavedRecipe[]> => {
      const { data, error } = await supabase
        .from("saved_recipes")
        .select("id, household_id, recipe_id, recipe, saved_by, created_at")
        .eq("household_id", householdId!)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as unknown as SavedRecipe[];
    },
  });

  const toggle = useMutation({
    mutationFn: async ({ recipe, saved }: { recipe: RecipeSuggestion; saved: boolean }) => {
      if (saved) {
        const { error } = await supabase.from("saved_recipes").delete()
          .eq("household_id", householdId!).eq("recipe_id", recipe.recipe_id);
        if (error) throw error;
      } else {
        const userId = useAuthStore.getState().user?.id;
        if (!userId || !householdId) throw new Error("not signed in");
        const { error } = await supabase.from("saved_recipes").insert({
          household_id: householdId, recipe_id: recipe.recipe_id, recipe, saved_by: userId,
        });
        if (error) throw error;
      }
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey }),
  });

  const savedIds = new Set((query.data ?? []).map((item) => item.recipe_id));
  return { ...query, savedIds, toggle: toggle.mutate, isToggling: toggle.isPending };
}
