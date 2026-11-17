import { Image } from "expo-image";
import type { ImageResult } from "@/types/images";

/**
 * Longest wait, in milliseconds, for a page's photos before its cards show
 * anyway. A card whose download is still running loads its photo itself.
 */
export const RECIPE_PHOTO_PRELOAD_CAP_MS = 3_000;

// Settles when the app's first `Image.loadAsync` call has finished. In
// expo-image before 56 on iOS, that call creates the loader behind
// `loadAsync` without a lock, so overlapping first calls race and the app
// crashes with EXC_BAD_ACCESS: https://github.com/expo/expo/pull/44010
// Every `Image.loadAsync` call in the app must wait on this promise.
let loaderReady: Promise<void> | undefined;

function download(uri: string, cacheKey: string): Promise<void> {
  // `Image.prefetch` caches under the URL, which is re-signed per request,
  // so it would miss the `cacheKey` lookup in `RecipePhoto`.
  const load = () =>
    Image.loadAsync({ uri, cacheKey })
      .then((image) => image.release())
      .catch(() => undefined);
  if (loaderReady) return loaderReady.then(load);
  loaderReady = load();
  return loaderReady;
}

/**
 * Downloads the `ready` photos into the on-disk image cache under each
 * result's `image_key`, the key `RecipePhoto` reads, so a card renders its
 * photo from cache on first paint.
 *
 * The first photo the app ever downloads this way goes alone, and every
 * other photo starts once it has finished. After that, a page's photos
 * download together.
 *
 * Resolves when every download has settled or after
 * {@link RECIPE_PHOTO_PRELOAD_CAP_MS}, whichever comes first. It never
 * rejects: a failed download leaves that card to load its photo normally.
 */
export async function preloadRecipePhotos(
  results: readonly ImageResult[],
): Promise<void> {
  const downloads = results.flatMap(({ status, url, image_key }) =>
    status === "ready" && url ? [download(url, image_key)] : [],
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
