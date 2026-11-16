import { useQuery } from "@tanstack/react-query";
import { ApiError } from "@/lib/api";
import { fetchRecipeImage } from "@/lib/image-api";
import type { ImageResult } from "@/types/images";

const PENDING_POLL_MS = 4_000;
const URL_EXPIRY_MARGIN_MS = 60_000;
const UNAVAILABLE_STALE_MS = 15 * 60_000;

/**
 * Returns the generated photo for a recipe snapshot.
 *
 * Reads `POST /api/images/recipes/{recipeId}` under the query key
 * `['recipe-image', recipeId]`. Feed and saved copies of a recipe share its
 * `recipe_id`, so every view reuses one result. A `ready` result stays fresh
 * until a minute before its signed URL expires. A `pending` result polls
 * every 4 seconds while a view is mounted. An `unavailable` result is kept
 * for 15 minutes. Errors are not retried for 4xx responses and are retried
 * once otherwise; the view shows its placeholder either way.
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
    staleTime: (query) => freshForMs(query.state.data, query.state.dataUpdatedAt),
    refetchInterval: (query) =>
      query.state.data?.status === "pending" ? PENDING_POLL_MS : false,
    refetchOnWindowFocus: false,
    retry: (failureCount, error) =>
      !(error instanceof ApiError && error.status < 500) && failureCount < 1,
  });
}

function freshForMs(result: ImageResult | undefined, fetchedAt: number): number {
  if (result?.status === "unavailable") return UNAVAILABLE_STALE_MS;
  if (result?.status !== "ready" || !result.expires_at) return 0;
  const expiresAt = Date.parse(result.expires_at);
  return Math.max(0, expiresAt - URL_EXPIRY_MARGIN_MS - fetchedAt);
}
