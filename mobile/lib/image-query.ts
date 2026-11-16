import type { Query } from "@tanstack/react-query";
import { ApiError } from "@/lib/api";
import type { ImageResult } from "@/types/images";

const PENDING_POLL_MS = 4_000;
const URL_EXPIRY_MARGIN_MS = 60_000;
const UNAVAILABLE_STALE_MS = 15 * 60_000;
const LATE_STALE_MS = 60_000;

type ImageQuery = Query<ImageResult, Error, ImageResult, readonly unknown[]>;

/**
 * Caching, polling and retry options shared by the generated-image queries.
 *
 * A `ready` result stays fresh until a minute before its signed URL
 * expires. A `pending` result polls every 4 seconds while a view is
 * mounted. An `unavailable` result is kept for 15 minutes, except a `late`
 * one, which a view mounted a minute or more later asks for again. 4xx
 * errors are not retried and other errors are retried once. A retry cannot
 * start a second generation while one runs, because the backend claims each
 * image before generating it.
 */
export const imageQueryPolicy = {
  staleTime: (query: ImageQuery) =>
    freshForMs(query.state.data, query.state.dataUpdatedAt),
  refetchInterval: (query: ImageQuery) =>
    query.state.data?.status === "pending" ? PENDING_POLL_MS : false,
  refetchOnWindowFocus: false,
  retry: (failureCount: number, error: Error) =>
    !(error instanceof ApiError && error.status < 500) && failureCount < 1,
} as const;

function freshForMs(result: ImageResult | undefined, fetchedAt: number): number {
  if (result?.status === "unavailable") {
    return result.reason === "late" ? LATE_STALE_MS : UNAVAILABLE_STALE_MS;
  }
  if (result?.status !== "ready" || !result.expires_at) return 0;
  const expiresAt = Date.parse(result.expires_at);
  return Math.max(0, expiresAt - URL_EXPIRY_MARGIN_MS - fetchedAt);
}
