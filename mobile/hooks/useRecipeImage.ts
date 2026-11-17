import { useQuery } from "@tanstack/react-query";
import { fetchRecipeImage } from "@/lib/image-api";
import { imageQueryPolicy } from "@/lib/image-query";

/**
 * Returns the generated photo for a recipe snapshot.
 *
 * Reads `POST /api/images/recipes/{recipeId}` under the query key
 * `['recipe-image', recipeId]`. Feed and saved copies of a recipe share its
 * `recipe_id`, so every view reuses one result. Freshness, polling and
 * retries follow {@link imageQueryPolicy}. On an error the view shows its
 * placeholder.
 *
 * @param recipeId - The recipe snapshot's `recipe_id`.
 * @param options.enabled - `false` defers the request, for example for feed
 * cards the user has not reached yet, since the first request may start a
 * paid generation. Defaults to `true`.
 */
export function useRecipeImage(
  recipeId: string,
  { enabled = true }: { enabled?: boolean } = {},
) {
  return useQuery({
    queryKey: ["recipe-image", recipeId] as const,
    queryFn: ({ signal }) => fetchRecipeImage(recipeId, signal),
    enabled,
    ...imageQueryPolicy,
  });
}
