import { apiFetch } from "@/lib/api";
import {
  RECIPE_PREFERENCE_KEYS,
  type RecipeFeedResponse,
  type RecipeFeedRestoreResponse,
  type RecipeFeedSessionRequest,
  type RecipeFeedSteering,
  type RecipePreferences,
} from "@/types/recipes";

export const RECIPE_FEED_PAGE_SIZE = 5;
/**
 * How long the app waits for a feed response. It is above the backend's
 * 48 s session and 43 s page budgets, which include generating each batch's
 * photos, so the app receives the server's own answer instead of aborting
 * first.
 */
export const RECIPE_FEED_REQUEST_TIMEOUT_MS = 50_000;
/**
 * How long the app waits to read a feed back after a restart. It is above
 * the backend's 8 s restore budget, and short because the Recipes tab shows
 * a loading state until the read settles.
 */
export const RECIPE_FEED_RESTORE_TIMEOUT_MS = 10_000;

type RecipeFeedPageRequest = {
  sessionId: string;
  cursor: string;
  signal?: AbortSignal;
  /** Steers the batch the page generates. */
  steering?: RecipeFeedSteering;
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
  steering,
}: RecipeFeedPageRequest): Promise<RecipeFeedResponse> {
  return requestWithTimeout(signal, (requestSignal) =>
    apiFetch<RecipeFeedResponse>(
      `/api/recipes/sessions/${encodeURIComponent(sessionId)}/pages`,
      {
        method: "POST",
        body: JSON.stringify({
          cursor,
          limit: RECIPE_FEED_PAGE_SIZE,
          ...(steering && { steering }),
        }),
        signal: requestSignal,
      },
    ),
  );
}

/** The restore response as sent, before its stored answers are checked. */
type StoredRecipeFeed = {
  data:
    | (Omit<NonNullable<RecipeFeedRestoreResponse["data"]>, "preferences"> & {
        preferences: Record<string, unknown>;
      })
    | null;
};

/**
 * Reads the caller's newest live feed session and its stored cards. The
 * backend only reads for this call: it never generates recipes or photos.
 * Stored answers that aren't {@link RecipePreferences} are left out.
 *
 * @throws {@link ApiError} when the backend answers with an error status,
 *   such as 503 `RECIPE_FEED_UNAVAILABLE`. Rejects with an abort error after
 *   {@link RECIPE_FEED_RESTORE_TIMEOUT_MS} or when `signal` aborts.
 */
export async function fetchLatestRecipeFeed(
  signal?: AbortSignal,
): Promise<RecipeFeedRestoreResponse> {
  const response = await requestWithTimeout(
    signal,
    (requestSignal) =>
      apiFetch<StoredRecipeFeed>("/api/recipes/sessions/latest", {
        signal: requestSignal,
      }),
    RECIPE_FEED_RESTORE_TIMEOUT_MS,
  );
  if (!response.data) return { data: null };
  const { preferences, ...data } = response.data;
  return { data: { ...data, preferences: knownPreferences(preferences) } };
}

function knownPreferences(stored: Record<string, unknown>): RecipePreferences {
  const preferences: RecipePreferences = {};
  for (const key of RECIPE_PREFERENCE_KEYS) {
    const value = stored[key];
    if (typeof value === "string") preferences[key] = value;
  }
  return preferences;
}

async function requestWithTimeout<T>(
  parentSignal: AbortSignal | undefined,
  request: (signal: AbortSignal) => Promise<T>,
  timeoutMs = RECIPE_FEED_REQUEST_TIMEOUT_MS,
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const abortParent = () => controller.abort();
  // An abort listener never fires for a signal that is already aborted,
  // so an aborted caller must cancel the request before it starts.
  if (parentSignal?.aborted) {
    controller.abort();
  } else {
    parentSignal?.addEventListener("abort", abortParent, { once: true });
  }

  try {
    return await request(controller.signal);
  } finally {
    clearTimeout(timeout);
    parentSignal?.removeEventListener("abort", abortParent);
  }
}
