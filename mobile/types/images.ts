/**
 * Why a generated image is not shown. `disabled`: generation is off, or the
 * recipe can only be served from cache. `budget_exhausted`: the monthly
 * spending cap is reached. `failed`: the last attempt failed.
 */
export type ImageUnavailableReason = "disabled" | "budget_exhausted" | "failed";

/** What the backend's image endpoints return for one generated image. */
export type ImageResult = {
  /**
   * `ready` when `url` serves the image, `pending` while another request
   * generates it, `unavailable` when the screen shows its placeholder.
   */
  status: "ready" | "pending" | "unavailable";
  /**
   * Stable identity of the image, the same in every view of its subject.
   * The client caches image bytes under it, because `url` is re-signed on
   * every request.
   */
  image_key: string;
  /** Signed URL of the WebP image. Set only when `status` is `ready`. */
  url: string | null;
  /** ISO 8601 time when `url` stops working. Set only when `ready`. */
  expires_at: string | null;
  /** Set only when `status` is `unavailable`. */
  reason: ImageUnavailableReason | null;
};

/** Response body of the image endpoints. */
export type ImageResponse = { data: ImageResult };
