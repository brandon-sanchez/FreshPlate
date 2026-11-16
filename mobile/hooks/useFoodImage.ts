import { skipToken, useQuery } from "@tanstack/react-query";
import { fetchFoodImage } from "@/lib/image-api";
import { imageQueryPolicy } from "@/lib/image-query";

/**
 * Returns the generated thumbnail for a household food.
 *
 * Reads `POST /api/images/foods/{foodId}` under the query key
 * `['food-image', foodId]`, so an inventory row, an add-form suggestion and
 * a recipe ingredient that draw on one food share a single result.
 * Freshness, polling and retries follow {@link imageQueryPolicy}. On an
 * error the view shows its placeholder.
 *
 * @param foodId - The food's id, or `null` for water or another ingredient
 * that uses no food. `null` never makes a request.
 * @param options.enabled - `false` defers the request until the view is on
 * screen, since the first request for an ingredient may start a paid
 * generation. Defaults to `true`.
 */
export function useFoodImage(
  foodId: string | null,
  { enabled = true }: { enabled?: boolean } = {},
) {
  return useQuery({
    queryKey: ["food-image", foodId] as const,
    queryFn:
      foodId === null
        ? skipToken
        : ({ signal }) => fetchFoodImage(foodId, signal),
    enabled,
    ...imageQueryPolicy,
  });
}
