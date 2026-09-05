import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
  type InfiniteData,
} from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  createRecipeFeedSession,
  fetchRecipeFeedPage,
  RECIPE_FEED_PAGE_SIZE,
  RECIPE_FEED_REQUEST_TIMEOUT_MS,
} from "@/lib/recipe-feed-api";
import type {
  RecipeFeedResponse,
  RecipeFeedSessionRequest,
  RecipeSuggestion,
} from "@/types/recipes";

export const RECIPE_FEED_READY_POOL_TARGET = 10;
export const RECIPE_FEED_PREFETCH_BATCH_CEILING = RECIPE_FEED_PAGE_SIZE;
export const RECIPE_FEED_MAX_RUNS = 6;
export const RECIPE_FEED_UNSEEN_BUFFER = 8;
export { RECIPE_FEED_REQUEST_TIMEOUT_MS };

export type RecipeFeedStatus = "idle" | "loading" | "ready" | "error";

type StartMutationInput = {
  request: RecipeFeedSessionRequest;
  signal: AbortSignal;
};

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

  const createMutation = useMutation<RecipeFeedResponse, Error, StartMutationInput>({
    mutationFn: ({ request, signal }) => createRecipeFeedSession(request, signal),
    retry: false,
  });

  const feedQuery = useInfiniteQuery<
    RecipeFeedResponse,
    Error,
    InfiniteData<RecipeFeedResponse, string>,
    [string, string | null],
    string
  >({
    queryKey: ["recipe-feed", sessionId],
    enabled: sessionId !== null,
    initialPageParam: "0",
    queryFn: async ({ pageParam, signal }) => {
      if (!sessionId) throw new Error("Recipe feed session is not ready");
      const started = Date.now();
      const page = await fetchRecipeFeedPage({ sessionId, cursor: pageParam, signal });
      if (sessionIdRef.current === sessionId) {
        pageLatencyMsRef.current = Math.max(1_000, Date.now() - started);
      }
      return page;
    },
    getNextPageParam: (lastPage) => lastPage?.data.next_cursor ?? undefined,
    staleTime: Infinity,
    retry: 1,
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

  const dismiss = useCallback((recipeId: string) => {
    if (dismissedIdsRef.current.has(recipeId)) return;
    dismissedIdsRef.current.add(recipeId);
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
    maybePrefetch,
  };
}
