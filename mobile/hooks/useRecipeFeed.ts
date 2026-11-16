import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
  type InfiniteData,
  type QueryClient,
} from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError } from "@/lib/api";
import {
  createRecipeFeedSession,
  fetchRecipeFeedPage,
  RECIPE_FEED_PAGE_SIZE,
  RECIPE_FEED_REQUEST_TIMEOUT_MS,
} from "@/lib/recipe-feed-api";
import { preloadRecipePhotos } from "@/lib/recipe-photo-preload";
import {
  keepSteeredCards,
  steeringRequest,
  type SteerDirection,
  type SteerSignal,
} from "@/lib/recipe-steering";
import type { ImageResult } from "@/types/images";
import type {
  RecipeFeedResponse,
  RecipeFeedSessionRequest,
  RecipeSuggestion,
} from "@/types/recipes";

export const RECIPE_FEED_READY_POOL_TARGET = 10;
export const RECIPE_FEED_PREFETCH_BATCH_CEILING = RECIPE_FEED_PAGE_SIZE;
export const RECIPE_FEED_MAX_RUNS = 6;
export { RECIPE_FEED_REQUEST_TIMEOUT_MS };

export type RecipeFeedStatus = "idle" | "loading" | "ready" | "error";

/** A feed response whose photos have moved to the recipe image cache. */
type RecipeFeedPage = {
  data: Omit<RecipeFeedResponse["data"], "recipes"> & {
    recipes: RecipeSuggestion[];
  };
};

/**
 * Seeds each card's photo under `['recipe-image', recipe_id]`, the key
 * `useRecipeImage` reads, so a card shows its photo without another request.
 * Resolves once the photos are downloaded or the preload cap passes, so a
 * page's cards never join the feed with a photo still downloading.
 * The photo is left off the returned recipes, because saved recipes and cook
 * events store the recipe as a snapshot and a signed URL must not go with it.
 */
async function unpackPhotos(
  queryClient: QueryClient,
  response: RecipeFeedResponse,
): Promise<RecipeFeedPage> {
  const images: ImageResult[] = [];
  const recipes = response.data.recipes.map(({ image, ...recipe }) => {
    if (image) {
      queryClient.setQueryData(["recipe-image", recipe.recipe_id], image);
      images.push(image);
    }
    return recipe;
  });
  await preloadRecipePhotos(images);
  return { data: { ...response.data, recipes } };
}

type StartMutationInput = {
  request: RecipeFeedSessionRequest;
  signal: AbortSignal;
};

/**
 * Retries a failed page once, and only when no server answer arrived. A
 * server answer such as 503 `AI_UNAVAILABLE` comes after the page's
 * generation budget is spent, so a retry would pay for a second generation
 * that fails the same way.
 */
function retryUnansweredOnce(failureCount: number, error: Error): boolean {
  return !(error instanceof ApiError) && failureCount < 1;
}

function toError(value: unknown): Error {
  if (value instanceof Error) return value;
  return new Error("Couldn't load recipes");
}

function uniqueRecipes(recipes: RecipeSuggestion[]): RecipeSuggestion[] {
  const seenIds = new Set<string>();
  const seenTitles = new Set<string>();
  return recipes.filter((recipe) => {
    const title = recipe.title.trim().toLocaleLowerCase();
    if (seenIds.has(recipe.recipe_id) || (title && seenTitles.has(title))) {
      return false;
    }
    seenIds.add(recipe.recipe_id);
    if (title) seenTitles.add(title);
    return true;
  });
}

/**
 * Runs one recipe feed session: creates it, pages through its cards and
 * keeps an unseen reserve loaded ahead of the user.
 *
 * Calls `POST /api/recipes/sessions` and
 * `POST /api/recipes/sessions/{id}/pages`, caching pages under
 * `['recipe-feed', sessionId]`. Each card's photo is seeded under
 * `['recipe-image', recipe_id]` and its bytes are downloaded before the
 * page's cards are returned, so cards show photos without a request of their
 * own. Starting a new session cancels and removes the previous one.
 *
 * `steer` records a "More like this" or "Less like this" press for the rest
 * of the session. Every later page request carries the picks, so batches are
 * generated toward or away from them, and arriving cards are filtered by
 * {@link keepSteeredCards}. A "More like this" press also requests the next
 * page at once, or as soon as a page already loading lands. Pressing it again
 * on the same recipe while that page is on its way changes nothing. The
 * caller removes the swept cards on screen with `dismiss`.
 */
export function useRecipeFeed() {
  const queryClient = useQueryClient();
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [status, setStatus] = useState<RecipeFeedStatus>("idle");
  const [error, setError] = useState<Error | null>(null);
  const [isBootstrapping, setIsBootstrapping] = useState(false);
  const [dismissedVersion, setDismissedVersion] = useState(0);
  const [requestVersion, setRequestVersion] = useState(0);
  const [consumptionVersion, setConsumptionVersion] = useState(0);
  const seenIdsRef = useRef(new Set<string>());
  const bufferTargetRef = useRef(RECIPE_FEED_READY_POOL_TARGET);
  const pageLatencyMsRef = useRef(25_000);
  const consumptionSampleRef = useRef({ time: 0, count: 0 });
  const activePageRef = useRef<string | null>(null);

  const requestRef = useRef<RecipeFeedSessionRequest | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const generationRef = useRef(0);
  const dismissedIdsRef = useRef(new Set<string>());
  const activeStartControllerRef = useRef<AbortController | null>(null);
  const signalsRef = useRef<readonly SteerSignal[]>([]);
  const steeredPageWantedRef = useRef(false);
  const [steerVersion, setSteerVersion] = useState(0);

  const createMutation = useMutation<RecipeFeedPage, Error, StartMutationInput>({
    mutationFn: async ({ request, signal }) =>
      unpackPhotos(queryClient, await createRecipeFeedSession(request, signal)),
    retry: false,
  });

  const feedQuery = useInfiniteQuery<
    RecipeFeedPage,
    Error,
    InfiniteData<RecipeFeedPage, string>,
    [string, string | null],
    string
  >({
    queryKey: ["recipe-feed", sessionId],
    enabled: sessionId !== null,
    initialPageParam: "0",
    queryFn: async ({ pageParam, signal }) => {
      if (!sessionId) throw new Error("Recipe feed session is not ready");
      const started = Date.now();
      const requested = signalsRef.current;
      steeredPageWantedRef.current = false;
      const response = await fetchRecipeFeedPage({
        sessionId,
        cursor: pageParam,
        signal,
        steering: steeringRequest(requested),
      });
      const recipes = keepSteeredCards(
        response.data.recipes,
        signalsRef.current,
        requested,
      );
      const page = await unpackPhotos(queryClient, {
        data: { ...response.data, recipes },
      });
      // The photo preload counts toward latency, because the buffer must
      // cover the whole wait until a page's cards can show.
      if (sessionIdRef.current === sessionId) {
        pageLatencyMsRef.current = Math.max(1_000, Date.now() - started);
      }
      return page;
    },
    getNextPageParam: (lastPage) => lastPage?.data.next_cursor ?? undefined,
    staleTime: Infinity,
    retry: retryUnansweredOnce,
    retryDelay: 250,
  });

  const abortActiveStart = useCallback(() => {
    activeStartControllerRef.current?.abort();
    activeStartControllerRef.current = null;
  }, []);

  useEffect(() => {
    return () => abortActiveStart();
  }, [abortActiveStart]);

  const start = useCallback(
    (request: RecipeFeedSessionRequest) => {
      abortActiveStart();
      const generation = generationRef.current + 1;
      generationRef.current = generation;
      const previousSessionId = sessionIdRef.current;
      if (previousSessionId) {
        void queryClient.cancelQueries({
          queryKey: ["recipe-feed", previousSessionId],
        });
        queryClient.removeQueries({
          queryKey: ["recipe-feed", previousSessionId],
        });
      }

      const controller = new AbortController();
      activeStartControllerRef.current = controller;
      requestRef.current = request;
      sessionIdRef.current = null;
      dismissedIdsRef.current.clear();
      seenIdsRef.current.clear();
      signalsRef.current = [];
      steeredPageWantedRef.current = false;
      activePageRef.current = null;
      bufferTargetRef.current = RECIPE_FEED_READY_POOL_TARGET;
      pageLatencyMsRef.current = 25_000;
      consumptionSampleRef.current = { time: 0, count: 0 };
      setConsumptionVersion((value) => value + 1);
      setDismissedVersion((value) => value + 1);
      setRequestVersion((value) => value + 1);
      setSessionId(null);
      setStatus("loading");
      setError(null);
      setIsBootstrapping(false);

      void createMutation
        .mutateAsync({ request, signal: controller.signal })
        .then((firstPage) => {
          if (generationRef.current !== generation) return;
          const nextSessionId = firstPage.data.session_id;
          sessionIdRef.current = nextSessionId;
          queryClient.setQueryData(["recipe-feed", nextSessionId], {
            pages: [firstPage],
            pageParams: ["0"],
          });
          setSessionId(nextSessionId);
          setIsBootstrapping(
            firstPage.data.recipes.length === 0 && firstPage.data.has_more,
          );
          setStatus("ready");
        })
        .catch((value: unknown) => {
          if (generationRef.current !== generation) return;
          setError(toError(value));
          setStatus("error");
        })
        .finally(() => {
          if (activeStartControllerRef.current === controller) {
            activeStartControllerRef.current = null;
          }
        });
    },
    [abortActiveStart, createMutation, queryClient],
  );

  const allRecipes = useMemo(
    () =>
      uniqueRecipes(
        feedQuery.data?.pages.flatMap((page) => page.data.recipes) ?? [],
      ),
    [feedQuery.data],
  );
  const recipes = useMemo(
    () =>
      allRecipes.filter((recipe) => !dismissedIdsRef.current.has(recipe.recipe_id)),
    // The filter reads dismissedIdsRef, so these version counters are what
    // tell the memo the dismissed set changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [allRecipes, dismissedVersion, requestVersion],
  );

  const prefetchError =
    status === "ready" && feedQuery.error ? toError(feedQuery.error) : null;
  const isPrefetching = feedQuery.isFetchingNextPage;
  const isExhausted =
    status === "ready" &&
    !feedQuery.hasNextPage &&
    !feedQuery.isFetchingNextPage &&
    feedQuery.data !== undefined;

  const loadNextPage = useCallback((retryFailedPage = false) => {
    if (
      status !== "ready" || !sessionId ||
      !feedQuery.hasNextPage || feedQuery.isFetching ||
      activePageRef.current === sessionId ||
      (feedQuery.error && !retryFailedPage)
    ) return;

    // All prefetch triggers share this synchronous lock. Scroll notifications
    // can arrive several times before React publishes the fetching state.
    activePageRef.current = sessionId;
    if (recipes.length === 0) setIsBootstrapping(true);
    void feedQuery.fetchNextPage({ cancelRefetch: false }).finally(() => {
      if (activePageRef.current === sessionId) activePageRef.current = null;
      if (sessionIdRef.current === sessionId) setIsBootstrapping(false);
    });
  }, [feedQuery, recipes.length, sessionId, status]);

  useEffect(() => {
    const unseenCount = recipes.filter(
      (recipe) => !seenIdsRef.current.has(recipe.recipe_id),
    ).length;
    if (unseenCount < bufferTargetRef.current) loadNextPage();
  }, [recipes, consumptionVersion, loadNextPage]);

  const maybePrefetch = useCallback((lastVisibleIndex: number) => {
    const consumed = recipes.slice(0, Math.max(0, lastVisibleIndex + 1));
    const previousCount = seenIdsRef.current.size;
    for (const recipe of consumed) seenIdsRef.current.add(recipe.recipe_id);
    const count = seenIdsRef.current.size;
    if (count !== previousCount) {
      const now = Date.now();
      const sample = consumptionSampleRef.current;
      if (sample.time === 0) {
        // The first viewport establishes the baseline; it isn't a scroll.
        consumptionSampleRef.current = { time: now, count };
      } else {
        const elapsed = Math.max(1_000, now - sample.time);
        const rate = (count - sample.count) / elapsed;
        // Reserve one measured refill's worth of browsing plus a viewport.
        // The clamp bounds speculative work even during a fling to the tail.
        bufferTargetRef.current = Math.min(20, Math.max(
          RECIPE_FEED_READY_POOL_TARGET,
          Math.ceil(rate * pageLatencyMsRef.current) + 3,
        ));
        if (elapsed >= 5_000) consumptionSampleRef.current = { time: now, count };
      }
      setConsumptionVersion((value) => value + 1);
    }
    const unseenCount = recipes.filter(
      (recipe) => !seenIdsRef.current.has(recipe.recipe_id),
    ).length;
    if (unseenCount < bufferTargetRef.current) loadNextPage();
  }, [loadNextPage, recipes]);

  useEffect(() => {
    if (!steeredPageWantedRef.current || feedQuery.isFetching) return;
    steeredPageWantedRef.current = false;
    loadNextPage();
  }, [feedQuery.isFetching, loadNextPage, steerVersion]);

  const steer = useCallback(
    (direction: SteerDirection, recipe: RecipeSuggestion) => {
      const latest = signalsRef.current.at(-1);
      const repeatsPendingMore =
        direction === "more" &&
        latest?.direction === "more" &&
        latest.recipe.recipe_id === recipe.recipe_id &&
        (steeredPageWantedRef.current || activePageRef.current !== null);
      // Each "More like this" batch is a paid generation, so a repeat press
      // waits for the batch already on its way.
      if (repeatsPendingMore) return;
      signalsRef.current = [
        ...signalsRef.current.filter(
          (signal) => signal.recipe.recipe_id !== recipe.recipe_id,
        ),
        { direction, recipe },
      ];
      if (direction === "more") {
        steeredPageWantedRef.current = true;
        setSteerVersion((value) => value + 1);
      }
    },
    [],
  );

  const dismiss = useCallback((recipeIds: readonly string[]) => {
    const fresh = recipeIds.filter((id) => !dismissedIdsRef.current.has(id));
    if (fresh.length === 0) return;
    for (const id of fresh) dismissedIdsRef.current.add(id);
    setDismissedVersion((value) => value + 1);
  }, []);

  const retry = useCallback(() => {
    if (requestRef.current) start(requestRef.current);
  }, [start]);

  const retryPrefetch = useCallback(() => {
    if (feedQuery.error) loadNextPage(true);
  }, [feedQuery.error, loadNextPage]);

  return {
    recipes,
    status,
    error,
    prefetchError,
    isBootstrapping,
    isPrefetching,
    isExhausted,
    runCount: feedQuery.data?.pages.length ?? 0,
    start,
    retry,
    retryPrefetch,
    dismiss,
    steer,
    maybePrefetch,
  };
}
