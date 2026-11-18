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
  fetchLatestRecipeFeed,
  fetchRecipeFeedPage,
  RECIPE_FEED_PAGE_SIZE,
  RECIPE_FEED_REQUEST_TIMEOUT_MS,
} from "@/lib/recipe-feed-api";
import {
  loadRecipeFeedMemory,
  saveRecipeFeedMemory,
} from "@/lib/recipe-feed-memory";
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
  RecipePreferences,
  RecipeSuggestion,
} from "@/types/recipes";
import type { RecipeFeedEnding } from "@/lib/recipes";

/**
 * The smallest reserve of unseen cards: a page loads once fewer unseen cards
 * than this remain.
 *
 * Every page past the first batch is a paid generation. Until the cook
 * first scrolls, steers or dismisses, the card on screen counts as unseen,
 * so a first batch of four or five cards buys no page before anyone moves.
 * On a five-card batch, the first swipe leaves three unseen and starts the
 * next batch.
 */
export const RECIPE_FEED_READY_POOL_TARGET = 4;
export const RECIPE_FEED_PREFETCH_BATCH_CEILING = RECIPE_FEED_PAGE_SIZE;
export const RECIPE_FEED_MAX_RUNS = 6;
// A restored feed asks for one unseen card ahead instead of a full reserve,
// so it loads a page only once every restored card has been seen. A full
// reserve would buy a generation as soon as the app opens.
const RESTORED_FEED_BUFFER_TARGET = 1;
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
 * The photo is left off the returned recipes, because saved recipes and cook
 * events store the recipe as a snapshot and a signed URL must not go with it.
 *
 * Without `shownFirstId`, it resolves once every photo is downloaded or the
 * preload cap passes, so a page's cards never join the feed with a photo
 * still downloading. With it, it resolves once that card's photo is in, and
 * the other photos keep downloading.
 */
async function unpackPhotos(
  queryClient: QueryClient,
  response: RecipeFeedResponse,
  shownFirstId?: string,
): Promise<RecipeFeedPage> {
  const awaited: ImageResult[] = [];
  const background: ImageResult[] = [];
  const recipes = response.data.recipes.map(({ image, ...recipe }) => {
    if (image) {
      queryClient.setQueryData(["recipe-image", recipe.recipe_id], image);
      const awaitsThis = !shownFirstId || recipe.recipe_id === shownFirstId;
      (awaitsThis ? awaited : background).push(image);
    }
    return recipe;
  });
  // Downloads start in call order, so the awaited photos go first.
  const shown = preloadRecipePhotos(awaited);
  void preloadRecipePhotos(background);
  await shown;
  return { data: { ...response.data, recipes } };
}

type RestoredFeed = {
  page: RecipeFeedPage;
  dismissedIds: string[];
  signals: SteerSignal[];
  preferences: RecipePreferences;
};

/**
 * Reads the caller's live session and the device's memory of it. Returns
 * `null` when there is no live session or every card in it was dismissed,
 * since the cook would see an empty feed.
 *
 * The page keeps the dismissed cards, without photos: `ending` tells a
 * dismissed feed from an empty one by them, and a "Less like this" pick is
 * usually a dismissed card.
 */
async function readLatestFeed(
  queryClient: QueryClient,
  signal: AbortSignal,
): Promise<RestoredFeed | null> {
  const response = await fetchLatestRecipeFeed(signal);
  if (!response.data) return null;
  const { preferences, ...data } = response.data;
  const memory = await loadRecipeFeedMemory(data.session_id);
  const dismissed = new Set(memory.dismissedIds);
  if (data.recipes.every((card) => dismissed.has(card.recipe_id))) return null;
  const pool = new Map(data.recipes.map((card) => [card.recipe_id, card]));
  const signals = memory.signals.flatMap(({ direction, recipeId }) => {
    const card = pool.get(recipeId);
    if (!card) return [];
    const { image: _image, ...recipe } = card;
    return [{ direction, recipe }];
  });
  const top = data.recipes.find((card) => !dismissed.has(card.recipe_id));
  const page = await unpackPhotos(
    queryClient,
    {
      data: {
        ...data,
        recipes: data.recipes.map((card) =>
          dismissed.has(card.recipe_id) ? { ...card, image: null } : card,
        ),
      },
    },
    top?.recipe_id,
  );
  return { page, dismissedIds: memory.dismissedIds, signals, preferences };
}

function recipeFeedKey(sessionId: string | null): [string, string | null] {
  return ["recipe-feed", sessionId];
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

/** Options for {@link useRecipeFeed}. */
export type UseRecipeFeedOptions = {
  /** Receives the answers a session read back on mount started with. */
  onSessionRestored?: (preferences: RecipePreferences) => void;
};

/**
 * Runs one recipe feed session: creates it, pages through its cards and
 * keeps an unseen reserve loaded ahead of the user. A page loads when fewer
 * than {@link RECIPE_FEED_READY_POOL_TARGET} unseen cards remain, counting
 * a dismissed card as gone, or when a "More like this" press asks for one.
 * Scrolling raises the reserve to cover one refill at the measured pace.
 *
 * Calls `POST /api/recipes/sessions` and
 * `POST /api/recipes/sessions/{id}/pages`, caching pages under
 * `['recipe-feed', sessionId]`. Each card's photo is seeded under
 * `['recipe-image', recipe_id]` and its bytes are downloaded before a
 * generated page's cards are returned, so cards show photos without a request
 * of their own. Starting a new session cancels and removes the previous one.
 *
 * `steer` records a "More like this" or "Less like this" press for the rest
 * of the session. Every later page request carries the picks, so batches are
 * generated toward or away from them, and arriving cards are filtered by
 * {@link keepSteeredCards}. A page of stored cards ignores the picks it
 * carries, so it is filtered against the picks of the request that
 * generated those cards. A "More like this" press also requests the next
 * page at once, or as soon as a page already loading lands. Pressing it again
 * on the same recipe while that page is on its way changes nothing. The
 * caller removes the swept cards on screen with `dismiss`, and `restore` puts
 * dismissed cards back in their places in the feed, as an undo does.
 *
 * On mount it calls `GET /api/recipes/sessions/latest` and, when a session is
 * still live, shows its stored cards again instead of the empty state.
 * `isRestoring` is true until that read and the top card's photo settle; the
 * other photos keep downloading behind the restored feed. Dismissals and
 * steer picks are kept in AsyncStorage through {@link saveRecipeFeedMemory},
 * so restored cards stay dismissed and later pages stay steered. A restored
 * feed loads another page only after the cook has seen every restored card,
 * or scrolls, steers or dismisses, so reopening the app pays for no recipe
 * generation while restored cards are left. Starting a session before the
 * read settles discards the restored one.
 */
export function useRecipeFeed({
  onSessionRestored,
}: UseRecipeFeedOptions = {}) {
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
  const hasBrowsedRef = useRef(false);
  // Stored cards ignore a page request's steering, so they are filtered
  // against the picks of the request that generated them instead.
  const poolSizeRef = useRef(0);
  const poolSignalsRef = useRef<readonly SteerSignal[]>([]);
  const [steerVersion, setSteerVersion] = useState(0);
  const [isRestoring, setIsRestoring] = useState(true);
  const onSessionRestoredRef = useRef(onSessionRestored);

  useEffect(() => {
    onSessionRestoredRef.current = onSessionRestored;
  }, [onSessionRestored]);

  const remember = useCallback(() => {
    const current = sessionIdRef.current;
    if (!current) return;
    void saveRecipeFeedMemory({
      sessionId: current,
      dismissedIds: [...dismissedIdsRef.current],
      signals: signalsRef.current.map(({ direction, recipe }) => ({
        direction,
        recipeId: recipe.recipe_id,
      })),
    });
  }, []);

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
    queryKey: recipeFeedKey(sessionId),
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
      const fromPool = Number(pageParam) < poolSizeRef.current;
      const recipes = keepSteeredCards(
        response.data.recipes,
        signalsRef.current,
        fromPool ? poolSignalsRef.current : requested,
      );
      const kept = new Set(recipes.map((recipe) => recipe.recipe_id));
      const heldBack = response.data.recipes.filter(
        (card) => !kept.has(card.recipe_id),
      );
      if (sessionIdRef.current === sessionId) {
        if (!fromPool) poolSignalsRef.current = requested;
        poolSizeRef.current = response.data.ready_count;
        if (heldBack.length > 0) {
          for (const card of heldBack) dismissedIdsRef.current.add(card.recipe_id);
          remember();
        }
      }
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

  const showFirstPage = useCallback(
    (page: RecipeFeedPage) => {
      const id = page.data.session_id;
      sessionIdRef.current = id;
      poolSizeRef.current = page.data.ready_count;
      remember();
      queryClient.setQueryData(recipeFeedKey(id), {
        pages: [page],
        pageParams: ["0"],
      });
      setSessionId(id);
      setIsBootstrapping(page.data.recipes.length === 0 && page.data.has_more);
      setStatus("ready");
    },
    [queryClient, remember],
  );

  useEffect(() => {
    const generation = generationRef.current;
    const controller = new AbortController();
    void readLatestFeed(queryClient, controller.signal)
      .then((restored) => {
        if (!restored || generationRef.current !== generation) return;
        dismissedIdsRef.current = new Set(restored.dismissedIds);
        signalsRef.current = restored.signals;
        bufferTargetRef.current = RESTORED_FEED_BUFFER_TARGET;
        // A restored feed resumes a session the cook already browsed, so the
        // card on screen counts as seen and the restore's own target applies.
        hasBrowsedRef.current = true;
        setDismissedVersion((value) => value + 1);
        showFirstPage(restored.page);
        onSessionRestoredRef.current?.(restored.preferences);
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          console.warn("Failed to restore the recipe feed:", error);
        }
      })
      .finally(() => setIsRestoring(false));
    return () => controller.abort();
  }, [queryClient, showFirstPage]);

  const start = useCallback(
    (request: RecipeFeedSessionRequest) => {
      abortActiveStart();
      const generation = generationRef.current + 1;
      generationRef.current = generation;
      const previousSessionId = sessionIdRef.current;
      if (previousSessionId) {
        void queryClient.cancelQueries({
          queryKey: recipeFeedKey(previousSessionId),
        });
        queryClient.removeQueries({
          queryKey: recipeFeedKey(previousSessionId),
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
      hasBrowsedRef.current = false;
      poolSizeRef.current = 0;
      poolSignalsRef.current = [];
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
      setIsRestoring(false);

      void createMutation
        .mutateAsync({ request, signal: controller.signal })
        .then((firstPage) => {
          if (generationRef.current === generation) showFirstPage(firstPage);
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
    [abortActiveStart, createMutation, queryClient, showFirstPage],
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

  const ending = useMemo<RecipeFeedEnding>(() => {
    if (recipes.length > 0) return { kind: "showing" };
    if (allRecipes.length > 0) return { kind: "dismissed" };
    const dish = feedQuery.data?.pages[0]?.data.requested_dish ?? "meal";
    return { kind: "empty", dish };
  }, [allRecipes.length, feedQuery.data, recipes.length]);

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

  const topUpReserve = useCallback(() => {
    // Until the cook first scrolls, steers or dismisses, the card on screen
    // counts as still ahead of them, so a four-card first batch doesn't buy
    // the next one before anyone has moved.
    const unseenCount = hasBrowsedRef.current
      ? recipes.filter((recipe) => !seenIdsRef.current.has(recipe.recipe_id))
          .length
      : recipes.length;
    if (unseenCount < bufferTargetRef.current) loadNextPage();
  }, [loadNextPage, recipes]);

  useEffect(() => {
    topUpReserve();
  }, [consumptionVersion, topUpReserve]);

  const maybePrefetch = useCallback((lastVisibleIndex: number) => {
    if (lastVisibleIndex > 0) hasBrowsedRef.current = true;
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
    topUpReserve();
  }, [recipes, topUpReserve]);

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
      hasBrowsedRef.current = true;
      signalsRef.current = [
        ...signalsRef.current.filter(
          (signal) => signal.recipe.recipe_id !== recipe.recipe_id,
        ),
        { direction, recipe },
      ];
      bufferTargetRef.current = Math.max(
        bufferTargetRef.current,
        RECIPE_FEED_READY_POOL_TARGET,
      );
      remember();
      if (direction === "more") {
        steeredPageWantedRef.current = true;
        setSteerVersion((value) => value + 1);
      }
    },
    [remember],
  );

  const dismiss = useCallback((recipeIds: readonly string[]) => {
    const fresh = recipeIds.filter((id) => !dismissedIdsRef.current.has(id));
    if (fresh.length === 0) return;
    for (const id of fresh) dismissedIdsRef.current.add(id);
    hasBrowsedRef.current = true;
    bufferTargetRef.current = Math.max(
      bufferTargetRef.current,
      RECIPE_FEED_READY_POOL_TARGET,
    );
    remember();
    setDismissedVersion((value) => value + 1);
  }, [remember]);

  const restore = useCallback((recipeIds: readonly string[]) => {
    const back = recipeIds.filter((id) => dismissedIdsRef.current.has(id));
    if (back.length === 0) return;
    for (const id of back) dismissedIdsRef.current.delete(id);
    remember();
    setDismissedVersion((value) => value + 1);
  }, [remember]);

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
    isRestoring,
    prefetchError,
    isBootstrapping,
    isPrefetching,
    isExhausted,
    ending,
    runCount: feedQuery.data?.pages.length ?? 0,
    start,
    retry,
    retryPrefetch,
    dismiss,
    restore,
    steer,
    maybePrefetch,
  };
}
