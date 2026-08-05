import { apiFetch } from "@/lib/api";
import type {
  RecipeFeedResponse,
  RecipeFeedSessionRequest,
} from "@/types/recipes";

export const RECIPE_FEED_PAGE_SIZE = 5;
export const RECIPE_FEED_REQUEST_TIMEOUT_MS = 35_000;

type RecipeFeedPageRequest = {
  sessionId: string;
  cursor: string;
  signal?: AbortSignal;
};

export async function createRecipeFeedSession(
  request: RecipeFeedSessionRequest,
  signal?: AbortSignal,
): Promise<RecipeFeedResponse> {
  return requestWithTimeout(signal, (requestSignal) =>
    apiFetch<RecipeFeedResponse>("/api/recipes/sessions", {
      method: "POST",
      body: JSON.stringify(request),
      signal: requestSignal,
    }),
  );
}

export async function fetchRecipeFeedPage({
  sessionId,
  cursor,
  signal,
}: RecipeFeedPageRequest): Promise<RecipeFeedResponse> {
  return requestWithTimeout(signal, (requestSignal) =>
    apiFetch<RecipeFeedResponse>(
      `/api/recipes/sessions/${encodeURIComponent(sessionId)}/pages`,
      {
        method: "POST",
        body: JSON.stringify({
          cursor,
          limit: RECIPE_FEED_PAGE_SIZE,
        }),
        signal: requestSignal,
      },
    ),
  );
}

async function requestWithTimeout<T>(
  parentSignal: AbortSignal | undefined,
  request: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    RECIPE_FEED_REQUEST_TIMEOUT_MS,
  );
  const abortParent = () => controller.abort();
  parentSignal?.addEventListener("abort", abortParent, { once: true });

  try {
    return await request(controller.signal);
  } finally {
    clearTimeout(timeout);
    parentSignal?.removeEventListener("abort", abortParent);
  }
}
