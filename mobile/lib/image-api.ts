import { apiFetch } from "@/lib/api";
import type { ImageResult, ImageResponse } from "@/types/images";

/**
 * Returns the generated photo for a recipe in the caller's feed or saved
 * recipes, calling `POST /api/images/recipes/{recipeId}` with the session JWT.
 *
 * The first request for a feed recipe may start one paid generation and
 * wait for it, so the call can take up to about two minutes. Aborting the
 * call does not cancel the generation on the server. A later call returns
 * the finished image.
 *
 * @throws {@link ApiError} with status 404 when the caller cannot see the
 * recipe, and 503 when the image service is unreachable.
 */
export async function fetchRecipeImage(
  recipeId: string,
  signal?: AbortSignal,
): Promise<ImageResult> {
  const response = await apiFetch<ImageResponse>(
    `/api/images/recipes/${encodeURIComponent(recipeId)}`,
    { method: "POST", signal },
  );
  return response.data;
}
