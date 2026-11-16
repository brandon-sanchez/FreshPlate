import { Image } from "expo-image";
import type { ImageResult } from "@/types/images";

/**
 * Longest wait, in milliseconds, for a page's photos before its cards show
 * anyway. A card whose download is still running loads its photo itself.
 */
export const RECIPE_PHOTO_PRELOAD_CAP_MS = 3_000;

/**
 * Downloads the `ready` photos into the on-disk image cache under each
 * result's `image_key`, the key `RecipePhoto` reads, so a card renders its
 * photo from cache on first paint.
 *
 * Resolves when every download has settled or after
 * {@link RECIPE_PHOTO_PRELOAD_CAP_MS}, whichever comes first. It never
 * rejects: a failed download leaves that card to load its photo normally.
 */
export async function preloadRecipePhotos(
  results: readonly ImageResult[],
): Promise<void> {
  const downloads = results.flatMap(({ status, url, image_key }) =>
    status === "ready" && url
      ? [
          // `Image.prefetch` caches under the URL, which is re-signed per
          // request, so it would miss the `cacheKey` lookup in `RecipePhoto`.
          Image.loadAsync({ uri: url, cacheKey: image_key }).then(
            (image) => image.release(),
            () => undefined,
          ),
        ]
      : [],
  );
  if (downloads.length === 0) return;

  let timer: ReturnType<typeof setTimeout> | undefined;
  const cap = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, RECIPE_PHOTO_PRELOAD_CAP_MS);
  });
  try {
    await Promise.race([Promise.all(downloads), cap]);
  } finally {
    clearTimeout(timer);
  }
}
