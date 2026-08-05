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

export const RECIPE_FEED_READY_POOL_TARGET = 8;
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
    queryFn: ({ pageParam, signal }) => {
      if (!sessionId) throw new Error("Recipe feed session is not ready");
      return fetchRecipeFeedPage({
        sessionId,
        cursor: pageParam,
        signal,
      });
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

  const loadNextPage = useCallback(() => {
    if (
      status !== "ready" ||
      !feedQuery.hasNextPage ||
      feedQuery.isFetchingNextPage ||
      feedQuery.error
    ) {
      return;
    }
    void feedQuery.fetchNextPage();
  }, [feedQuery, status]);

  useEffect(() => {
    const firstPage = feedQuery.data?.pages[0];
    const lastPage = feedQuery.data?.pages.at(-1);
    const isEmptyStartup = firstPage?.data.recipes.length === 0;
    const shouldContinueEmptyPage =
      lastPage !== undefined &&
      lastPage.data.recipes.length === 0 &&
      lastPage.data.has_more;
    const shouldPrimeReadyPool =
      recipes.length > 0 && recipes.length < RECIPE_FEED_READY_POOL_TARGET;
    if (
      status === "ready" &&
      feedQuery.data !== undefined &&
      feedQuery.hasNextPage &&
      !feedQuery.isFetchingNextPage &&
      !feedQuery.error &&
      (shouldContinueEmptyPage || shouldPrimeReadyPool)
    ) {
      const bootstrapGeneration = generationRef.current;
      if (isEmptyStartup) setIsBootstrapping(true);
      void feedQuery.fetchNextPage().finally(() => {
        if (generationRef.current === bootstrapGeneration && isEmptyStartup) {
          setIsBootstrapping(false);
        }
      });
    }
  }, [feedQuery, recipes.length, status]);

  const maybePrefetch = useCallback(
    (lastVisibleIndex: number) => {
      const unseenCount = recipes.length - Math.max(0, lastVisibleIndex + 1);
      if (unseenCount <= RECIPE_FEED_UNSEEN_BUFFER) loadNextPage();
    },
    [loadNextPage, recipes.length],
  );

  const dismiss = useCallback((recipeId: string) => {
    if (dismissedIdsRef.current.has(recipeId)) return;
    dismissedIdsRef.current.add(recipeId);
    setDismissedVersion((value) => value + 1);
  }, []);

  const retry = useCallback(() => {
    if (requestRef.current) start(requestRef.current);
  }, [start]);

  const retryPrefetch = useCallback(() => {
    if (!feedQuery.error || feedQuery.isFetchingNextPage) return;
    const isEmptyStartup =
      recipes.length === 0 &&
      feedQuery.data?.pages[0]?.data.recipes.length === 0;
    const retryGeneration = generationRef.current;
    if (isEmptyStartup) setIsBootstrapping(true);
    void feedQuery.fetchNextPage().finally(() => {
      if (generationRef.current === retryGeneration) {
        setIsBootstrapping(false);
      }
    });
  }, [feedQuery, recipes.length]);

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
