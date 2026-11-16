import React from "react";
import {
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import { act, cleanupAsync, renderHook, waitFor } from "@testing-library/react-native";
import type { ImageResult } from "@/types/images";
import type {
  RequestedDish,
  RecipeFeedCard,
  RecipeFeedResponse,
  RecipeFeedSessionRequest,
  RecipeSuggestion,
} from "@/types/recipes";

const mockCreateSession = jest.fn();
const mockFetchPage = jest.fn();

const mockLoadImage = jest.fn();

jest.mock("expo-image", () => ({
  Image: { loadAsync: (...args: unknown[]) => mockLoadImage(...args) },
}));

jest.mock("@/lib/recipe-feed-api", () => ({
  RECIPE_FEED_PAGE_SIZE: 5,
  RECIPE_FEED_REQUEST_TIMEOUT_MS: 50_000,
  createRecipeFeedSession: (...args: unknown[]) => mockCreateSession(...args),
  fetchRecipeFeedPage: (...args: unknown[]) => mockFetchPage(...args),
}));

jest.mock("@/lib/supabase", () => ({ supabase: {} }));

import { useRecipeFeed } from "@/hooks/useRecipeFeed";
import { ApiError } from "@/lib/api";

const request: RecipeFeedSessionRequest = {
  household_id: "household-1",
  preferences: { meal: "Dinner" },
};

function recipe(recipeId: string, title: string): RecipeSuggestion {
  return {
    recipe_id: recipeId,
    title,
    cook_time_minutes: 30,
    servings: 2,
    ingredients: [],
    steps: ["Cook it"],
    match_percent: 90,
    saves_expiring: [],
  };
}

function page(
  recipes: (RecipeSuggestion | RecipeFeedCard)[],
  nextCursor: string | null,
  hasMore: boolean,
  readyCount = recipes.length,
  requestedDish: RequestedDish = "meal",
): RecipeFeedResponse {
  return {
    data: {
      session_id: "session-1",
      recipes: recipes.map((item) => ({ image: null, ...item })),
      next_cursor: nextCursor,
      has_more: hasMore,
      ready_count: readyCount,
      empty_reason: null,
      requested_dish: requestedDish,
    },
  };
}

function photo(recipeId: string): ImageResult {
  return {
    status: "ready",
    image_key: `key-${recipeId}`,
    url: `https://cdn.test/${recipeId}.webp`,
    expires_at: "2099-01-01T00:00:00Z",
    reason: null,
  };
}

/** Provides each hook test with an isolated query cache and tracks it for cleanup. */
function wrapper({ children }: { children: React.ReactNode }) {
  const queryClient = new QueryClient({
    // A replaced session's query would otherwise hold a five-minute
    // garbage-collection timer that keeps Jest from exiting.
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  queryClients.add(queryClient);
  lastQueryClient = queryClient;
  return React.createElement(
    QueryClientProvider,
    { client: queryClient },
    children,
  );
}

const queryClients = new Set<QueryClient>();
let lastQueryClient: QueryClient | undefined;

describe("useRecipeFeed", () => {
  beforeEach(() => {
    mockCreateSession.mockReset();
    mockFetchPage.mockReset();
    mockLoadImage.mockReset();
    mockLoadImage.mockResolvedValue({ release: jest.fn() });
  });

  afterEach(async () => {
    await cleanupAsync();
    for (const queryClient of queryClients) {
      for (const mutation of queryClient.getMutationCache().getAll()) mutation.destroy();
      queryClient.clear();
    }
    queryClients.clear();
  });

  it("does not treat the initial viewport as a fast scroll", async () => {
    const batch = (start: number) => Array.from({ length: 5 }, (_, index) =>
      recipe(`${start + index}`, `Dish ${start + index}`),
    );
    mockCreateSession.mockResolvedValueOnce(page(batch(0), "5", true));
    let finish: ((value: RecipeFeedResponse) => void) | undefined;
    mockFetchPage.mockImplementation(() => new Promise<RecipeFeedResponse>((resolve) => { finish = resolve; }));
    const { result, unmount } = renderHook(() => useRecipeFeed(), { wrapper });
    act(() => result.current.start(request));
    await waitFor(() => expect(result.current.recipes).toHaveLength(5));
    act(() => result.current.maybePrefetch(2));
    finish?.(page(batch(5), "10", true));
    await waitFor(() => expect(mockFetchPage).toHaveBeenCalledTimes(2));
    finish?.(page(batch(10), "15", true));
    await waitFor(() => expect(result.current.recipes).toHaveLength(15));
    expect(mockFetchPage).toHaveBeenCalledTimes(2);
    unmount();
  });

  it("keeps refilling an unseen reserve after a fast scroll without another scroll event", async () => {
    const batch = (start: number, count: number) =>
      Array.from({ length: count }, (_, index) =>
        recipe(`recipe-${start + index}`, `Dish ${start + index}`),
      );
    mockCreateSession.mockResolvedValueOnce(page(batch(1, 10), "10", true));
    mockFetchPage
      .mockResolvedValueOnce(page(batch(11, 5), "15", true))
      .mockResolvedValueOnce(page(batch(16, 5), null, false));
    const { result } = renderHook(() => useRecipeFeed(), { wrapper });
    act(() => result.current.start(request));
    await waitFor(() => expect(result.current.recipes).toHaveLength(10));

    act(() => result.current.maybePrefetch(9));

    await waitFor(() => expect(result.current.recipes).toHaveLength(20));
    expect(mockFetchPage).toHaveBeenCalledTimes(2);
    expect(result.current.isExhausted).toBe(true);
  });

  it("coalesces a burst of tail notifications into one request without cancelling it", async () => {
    const head = Array.from({ length: 10 }, (_, index) =>
      recipe(`recipe-${index}`, `Dish ${index}`),
    );
    mockCreateSession.mockResolvedValueOnce(page(head, "10", true));
    let finish: ((value: RecipeFeedResponse) => void) | undefined;
    mockFetchPage.mockImplementation(() => new Promise<RecipeFeedResponse>((resolve) => {
      finish = resolve;
    }));
    const { result } = renderHook(() => useRecipeFeed(), { wrapper });
    act(() => result.current.start(request));
    await waitFor(() => expect(result.current.recipes).toHaveLength(10));
    act(() => {
      for (let index = 0; index < 30; index++) result.current.maybePrefetch(9);
    });
    await waitFor(() => expect(mockFetchPage).toHaveBeenCalledTimes(1));
    expect(mockFetchPage.mock.calls[0][0].signal.aborted).toBe(false);
    finish?.(page([], null, false));
    await waitFor(() => expect(result.current.isExhausted).toBe(true));
  });

  it.each([1_000, 25_000, 45_000])(
    "preserves every card through six batches with %i ms refills and rapid tail scrolling",
    async (latencyMs) => {
      const batch = (run: number) => Array.from({ length: 5 }, (_, index) =>
        recipe(`${run}-${index}`, `Dish ${run}-${index}`),
      );
      let now = 1_000_000;
      const clock = jest.spyOn(Date, "now").mockImplementation(() => now);
      let finish: ((value: RecipeFeedResponse) => void) | undefined;
      const signals: AbortSignal[] = [];
      mockCreateSession.mockResolvedValueOnce(page(batch(1), "5", true));
      mockFetchPage.mockImplementation(({ signal }: { signal: AbortSignal }) => {
        signals.push(signal);
        return new Promise<RecipeFeedResponse>((resolve) => { finish = resolve; });
      });
      const { result, unmount } = renderHook(() => useRecipeFeed(), { wrapper });
      try {
        act(() => result.current.start(request));
        await waitFor(() => expect(result.current.recipes).toHaveLength(5));
        for (let run = 2; run <= 6; run++) {
          now += 500;
          act(() => {
            for (let event = 0; event < 20; event++) {
              result.current.maybePrefetch(result.current.recipes.length - 1);
            }
          });
          await waitFor(() => expect(mockFetchPage).toHaveBeenCalledTimes(run - 1));
          expect(result.current.isPrefetching).toBe(true);
          expect(result.current.isExhausted).toBe(false);
          expect(signals.every((signal) => !signal.aborted)).toBe(true);
          now += latencyMs;
          finish?.(page(batch(run), run === 6 ? null : `${run * 5}`, run < 6));
          await waitFor(() => expect(result.current.recipes).toHaveLength(run * 5));
        }
        expect(new Set(result.current.recipes.map((item) => item.recipe_id)).size).toBe(30);
        expect(result.current.isExhausted).toBe(true);
        expect(result.current.prefetchError).toBeNull();
        expect(mockFetchPage).toHaveBeenCalledTimes(5);
      } finally {
        unmount();
        clock.mockRestore();
      }
    },
  );

  it("seeds the first page and fetches the next cursor at the low-water mark", async () => {
    mockCreateSession.mockResolvedValueOnce(
      page(
        [
          recipe("recipe-1", "Spinach Pasta"),
          recipe("recipe-2", "Spinach Curry"),
          recipe("recipe-3", "Green Omelet"),
          recipe("recipe-4", "Spinach Soup"),
          recipe("recipe-5", "Spinach Tacos"),
          recipe("recipe-6", "Spinach Rice"),
          recipe("recipe-7", "Spinach Toast"),
          recipe("recipe-8", "Spinach Hash"),
        ],
        "8",
        true,
      ),
    );
    mockFetchPage.mockResolvedValueOnce(
      page(
        [
          recipe("recipe-9", "Spinach Risotto"),
          recipe("recipe-10", "Spinach Flatbread"),
        ],
        null,
        false,
      ),
    );

    const { result } = renderHook(() => useRecipeFeed(), { wrapper });

    act(() => result.current.start(request));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    expect(mockCreateSession).toHaveBeenCalledWith(
      request,
      expect.any(AbortSignal),
    );
    expect(result.current.recipes.length).toBeGreaterThanOrEqual(8);

    act(() => result.current.maybePrefetch(2));
    await waitFor(() => expect(result.current.recipes).toHaveLength(10));

    expect(mockFetchPage).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "session-1",
        cursor: "8",
        signal: expect.any(AbortSignal),
      }),
    );
    expect(result.current.isExhausted).toBe(true);
  });

  it("primes the ready pool immediately after a short head arrives", async () => {
    mockCreateSession.mockResolvedValueOnce(
      page(
        [
          recipe("recipe-1", "Spinach Pasta"),
          recipe("recipe-2", "Spinach Curry"),
          recipe("recipe-3", "Green Omelet"),
          recipe("recipe-4", "Spinach Soup"),
          recipe("recipe-5", "Spinach Tacos"),
        ],
        "5",
        true,
        5,
      ),
    );
    mockFetchPage.mockResolvedValueOnce(
      page(
        [
          recipe("recipe-6", "Spinach Rice"),
          recipe("recipe-7", "Spinach Toast"),
          recipe("recipe-8", "Spinach Hash"),
        ],
        null,
        false,
        8,
      ),
    );

    const { result } = renderHook(() => useRecipeFeed(), { wrapper });

    act(() => result.current.start(request));
    await waitFor(() => expect(result.current.recipes).toHaveLength(8));

    expect(mockFetchPage).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "session-1",
        cursor: "5",
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("keeps head cards visible while the immediate refill is in flight", async () => {
    let resolvePage: ((value: RecipeFeedResponse) => void) | undefined;
    mockCreateSession.mockResolvedValueOnce(
      page(
        [
          recipe("recipe-1", "Spinach Pasta"),
          recipe("recipe-2", "Spinach Curry"),
          recipe("recipe-3", "Green Omelet"),
          recipe("recipe-4", "Spinach Soup"),
          recipe("recipe-5", "Spinach Tacos"),
        ],
        "5",
        true,
        5,
      ),
    );
    mockFetchPage.mockImplementationOnce(
      () =>
        new Promise<RecipeFeedResponse>((resolve) => {
          resolvePage = resolve;
        }),
    );

    const { result } = renderHook(() => useRecipeFeed(), { wrapper });

    act(() => result.current.start(request));
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.recipes).toHaveLength(5);
    expect(result.current.isPrefetching).toBe(true);

    resolvePage?.(
      page(
        [
          recipe("recipe-6", "Spinach Rice"),
          recipe("recipe-7", "Spinach Toast"),
          recipe("recipe-8", "Spinach Hash"),
        ],
        null,
        false,
        8,
      ),
    );
    await waitFor(() => expect(result.current.recipes).toHaveLength(8));
  });

  it("refills immediately when the startup page has no valid recipes", async () => {
    mockCreateSession.mockResolvedValueOnce(page([], "0", true));
    mockFetchPage.mockResolvedValueOnce(
      page([recipe("recipe-1", "Spinach Pasta")], null, false),
    );

    const { result } = renderHook(() => useRecipeFeed(), { wrapper });

    act(() => result.current.start(request));
    await waitFor(() => expect(result.current.recipes).toHaveLength(1));

    expect(mockFetchPage).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "session-1",
        cursor: "0",
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("continues bounded empty tail pages until another batch is available", async () => {
    mockCreateSession.mockResolvedValueOnce(
      page([recipe("recipe-1", "Spinach Pasta")], "1", true),
    );
    mockFetchPage
      .mockResolvedValueOnce(page([], "1", true))
      .mockResolvedValueOnce(page([recipe("recipe-2", "Spinach Soup")], null, false));

    const { result } = renderHook(() => useRecipeFeed(), { wrapper });
    act(() => result.current.start(request));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    act(() => result.current.maybePrefetch(0));
    await waitFor(() => expect(result.current.recipes).toHaveLength(2));

    expect(mockFetchPage).toHaveBeenCalledTimes(2);
  });

  it("keeps the generation loader visible until an empty startup is refilled", async () => {
    let resolvePage: ((value: RecipeFeedResponse) => void) | undefined;
    mockCreateSession.mockResolvedValueOnce(page([], "0", true));
    mockFetchPage.mockImplementationOnce(
      () =>
        new Promise<RecipeFeedResponse>((resolve) => {
          resolvePage = resolve;
        }),
    );

    const { result } = renderHook(() => useRecipeFeed(), { wrapper });

    act(() => result.current.start(request));
    await waitFor(() => expect(result.current.isBootstrapping).toBe(true));
    expect(result.current.recipes).toHaveLength(0);

    resolvePage?.(page([recipe("recipe-1", "Spinach Pasta")], null, false));
    await waitFor(() => expect(result.current.recipes).toHaveLength(1));
    expect(result.current.isBootstrapping).toBe(false);
  });

  it("retries a failed tail page silently once before surfacing the error", async () => {
    mockCreateSession.mockResolvedValueOnce(
      page([recipe("recipe-1", "Spinach Pasta")], "1", true),
    );
    mockFetchPage
      .mockRejectedValueOnce(new Error("AI unavailable"))
      .mockRejectedValueOnce(new Error("AI unavailable"))
      .mockResolvedValueOnce(
        page([recipe("recipe-2", "Spinach Soup")], null, false),
      );

    const { result } = renderHook(() => useRecipeFeed(), { wrapper });
    act(() => result.current.start(request));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    act(() => result.current.maybePrefetch(0));
    await waitFor(() => expect(result.current.prefetchError).not.toBeNull());
    // The failed page was fetched twice: the scroll event plus one silent
    // automatic retry (locked refill-failure contract).
    expect(mockFetchPage).toHaveBeenCalledTimes(2);

    // Repeated scroll events never refire a page that already failed twice.
    act(() => result.current.maybePrefetch(0));
    await Promise.resolve();
    expect(mockFetchPage).toHaveBeenCalledTimes(2);

    act(() => result.current.retryPrefetch());
    await waitFor(() => expect(result.current.recipes).toHaveLength(2));
    expect(mockFetchPage).toHaveBeenCalledTimes(3);
  });

  it("reports the dish the session asked for", async () => {
    mockCreateSession.mockResolvedValueOnce(page([], null, false, 0, "dessert"));
    const { result } = renderHook(() => useRecipeFeed(), { wrapper });
    act(() => result.current.start(request));

    await waitFor(() => expect(result.current.isExhausted).toBe(true));
    expect(result.current.ending).toEqual({ kind: "empty", dish: "dessert" });
  });

  it("tells a feed the cook dismissed apart from one that found nothing", async () => {
    mockCreateSession.mockResolvedValueOnce(
      page([recipe("a", "Dish A"), recipe("b", "Dish B")], null, false),
    );
    const { result } = renderHook(() => useRecipeFeed(), { wrapper });
    act(() => result.current.start(request));
    await waitFor(() => expect(result.current.recipes).toHaveLength(2));

    expect(result.current.ending).toEqual({ kind: "showing" });
    act(() => result.current.dismiss(["a", "b"]));

    expect(result.current.recipes).toHaveLength(0);
    expect(result.current.ending).toEqual({ kind: "dismissed" });
  });

  it("surfaces a tail page the server answered as out of time without retrying it", async () => {
    mockCreateSession.mockResolvedValueOnce(
      page([recipe("recipe-1", "Spinach Pasta")], "1", true),
    );
    mockFetchPage.mockRejectedValueOnce(
      new ApiError(503, "AI service unavailable", "AI_UNAVAILABLE"),
    );

    const { result } = renderHook(() => useRecipeFeed(), { wrapper });
    act(() => result.current.start(request));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    act(() => result.current.maybePrefetch(0));
    await waitFor(() => expect(result.current.prefetchError).not.toBeNull());
    expect(mockFetchPage).toHaveBeenCalledTimes(1);
  });

  it("surfaces a session the server answered as out of time without retrying it", async () => {
    mockCreateSession.mockRejectedValueOnce(
      new ApiError(503, "AI service unavailable", "AI_UNAVAILABLE"),
    );

    const { result } = renderHook(() => useRecipeFeed(), { wrapper });
    act(() => result.current.start(request));
    await waitFor(() => expect(result.current.status).toBe("error"));
    expect(mockCreateSession).toHaveBeenCalledTimes(1);
  });

  it("moves each card's photo into the recipe image cache", async () => {
    mockCreateSession.mockResolvedValueOnce(
      page(
        [
          { ...recipe("recipe-1", "Soup"), image: photo("recipe-1") },
          { ...recipe("recipe-2", "Stew"), image: null },
        ],
        "2",
        true,
      ),
    );
    mockFetchPage.mockResolvedValueOnce(
      page([{ ...recipe("recipe-3", "Salad"), image: photo("recipe-3") }], null, false),
    );

    const { result } = renderHook(() => useRecipeFeed(), { wrapper });
    act(() => result.current.start(request));
    await waitFor(() => expect(result.current.recipes).toHaveLength(3));

    const images = (id: string) =>
      lastQueryClient?.getQueryData(["recipe-image", id]);
    expect(images("recipe-1")).toEqual(photo("recipe-1"));
    expect(images("recipe-2")).toBeUndefined();
    expect(images("recipe-3")).toEqual(photo("recipe-3"));
    for (const card of result.current.recipes) expect(card).not.toHaveProperty("image");
  });

  it("adds a refill page's cards only after their photos are downloaded", async () => {
    mockCreateSession.mockResolvedValueOnce(
      page([recipe("recipe-1", "Soup"), recipe("recipe-2", "Stew")], "2", true),
    );
    mockFetchPage.mockResolvedValueOnce(
      page([{ ...recipe("recipe-3", "Salad"), image: photo("recipe-3") }], null, false),
    );
    let finishDownload: () => void = () => undefined;
    mockLoadImage.mockReturnValueOnce(
      new Promise((resolve) => {
        finishDownload = () => resolve({ release: jest.fn() });
      }),
    );

    const { result } = renderHook(() => useRecipeFeed(), { wrapper });
    act(() => result.current.start(request));
    await waitFor(() =>
      expect(mockLoadImage).toHaveBeenCalledWith({
        uri: photo("recipe-3").url,
        cacheKey: "key-recipe-3",
      }),
    );

    expect(result.current.recipes.map((card) => card.recipe_id)).toEqual([
      "recipe-1",
      "recipe-2",
    ]);
    await act(async () => finishDownload());
    await waitFor(() => expect(result.current.recipes).toHaveLength(3));
  });

  it("shows a page without waiting on a failed or stalled photo download", async () => {
    jest.useFakeTimers();
    try {
      mockCreateSession.mockResolvedValueOnce(
        page(
          [
            { ...recipe("recipe-1", "Soup"), image: photo("recipe-1") },
            { ...recipe("recipe-2", "Stew"), image: photo("recipe-2") },
          ],
          null,
          false,
        ),
      );
      mockLoadImage
        .mockRejectedValueOnce(new Error("download failed"))
        .mockReturnValueOnce(new Promise(() => undefined));

      const { result } = renderHook(() => useRecipeFeed(), { wrapper });
      act(() => result.current.start(request));
      await waitFor(() => expect(mockLoadImage).toHaveBeenCalledTimes(2));
      await act(async () => jest.advanceTimersByTime(2_900));
      expect(result.current.status).toBe("loading");

      await act(async () => jest.advanceTimersByTime(100));
      await waitFor(() => expect(result.current.recipes).toHaveLength(2));
    } finally {
      jest.useRealTimers();
    }
  });

  it("removes dismissed cards while retaining the server cursor", async () => {
    mockCreateSession.mockResolvedValueOnce(
      page(
        [recipe("recipe-1", "Spinach Pasta"), recipe("recipe-2", "Soup")],
        null,
        false,
      ),
    );

    const { result } = renderHook(() => useRecipeFeed(), { wrapper });
    act(() => result.current.start(request));
    await waitFor(() => expect(result.current.recipes).toHaveLength(2));

    act(() => result.current.dismiss(["recipe-1"]));
    await waitFor(() =>
      expect(result.current.recipes.map((item) => item.title)).toEqual(["Soup"]),
    );
    expect(result.current.isExhausted).toBe(true);
  });

  describe("steering", () => {
    const withFoods = (recipeId: string, foods: string[]): RecipeSuggestion => ({
      ...recipe(recipeId, recipeId),
      ingredients: foods.map((food) => ({
        name: food,
        inventory_item_id: food,
        use_amount: 1,
        unit: "each",
      })),
    });
    const salmon = withFoods("salmon", ["salmon", "rice", "lemon", "peas"]);
    const salmonToo = withFoods("salmon-too", ["salmon", "rice", "lemon", "garlic"]);
    const stew = withFoods("stew", ["chickpeas", "tomatoes", "carrots", "garlic"]);
    const stewToo = withFoods("stew-too", ["chickpeas", "tomatoes", "carrots", "oil"]);
    const head = Array.from({ length: 9 }, (_, index) =>
      withFoods(`head-${index}`, [`food-${index}`, `other-${index}`]),
    );

    async function startFeed() {
      mockCreateSession.mockResolvedValueOnce(page([salmon, ...head], "10", true));
      const hook = renderHook(() => useRecipeFeed(), { wrapper });
      act(() => hook.result.current.start(request));
      await waitFor(() => expect(hook.result.current.recipes).toHaveLength(10));
      return hook;
    }

    it("asks for a batch steered toward the card right after More like this", async () => {
      mockFetchPage.mockReturnValue(new Promise(() => undefined));
      const { result } = await startFeed();
      expect(mockFetchPage).not.toHaveBeenCalled();

      act(() => result.current.steer("more", salmon));

      await waitFor(() =>
        expect(mockFetchPage).toHaveBeenCalledWith(
          expect.objectContaining({
            cursor: "10",
            steering: { more_like: ["salmon"], less_like: [] },
          }),
        ),
      );
      await waitFor(() => expect(result.current.isPrefetching).toBe(true));
    });

    it("steers later batches away from a Less like this card and drops alike cards", async () => {
      mockFetchPage.mockResolvedValueOnce(page([stewToo, salmonToo], null, false));
      const { result } = await startFeed();

      act(() => result.current.steer("less", stew));
      act(() => result.current.maybePrefetch(9));

      await waitFor(() => expect(result.current.isExhausted).toBe(true));
      expect(mockFetchPage).toHaveBeenCalledWith(
        expect.objectContaining({
          steering: { more_like: [], less_like: ["stew"] },
        }),
      );
      expect(result.current.recipes.map((item) => item.recipe_id)).toContain("salmon-too");
      expect(result.current.recipes.map((item) => item.recipe_id)).not.toContain("stew-too");
    });

    it("keeps only alike cards from a batch already loading when More like this is pressed", async () => {
      let finish: ((value: RecipeFeedResponse) => void) | undefined;
      mockFetchPage
        .mockImplementationOnce(
          () => new Promise<RecipeFeedResponse>((resolve) => { finish = resolve; }),
        )
        .mockReturnValue(new Promise(() => undefined));
      const { result } = await startFeed();
      act(() => result.current.maybePrefetch(9));
      await waitFor(() => expect(mockFetchPage).toHaveBeenCalledTimes(1));

      act(() => result.current.steer("more", salmon));
      await act(async () => finish?.(page([stewToo, salmonToo], "12", true)));

      await waitFor(() => expect(mockFetchPage).toHaveBeenCalledTimes(2));
      expect(mockFetchPage).toHaveBeenLastCalledWith(
        expect.objectContaining({
          cursor: "12",
          steering: { more_like: ["salmon"], less_like: [] },
        }),
      );
      const ids = result.current.recipes.map((item) => item.recipe_id);
      expect(ids).toContain("salmon-too");
      expect(ids).not.toContain("stew-too");
    });

    it("keeps a card alike to a Less pick when a later More pick is alike too", async () => {
      const stewThree = withFoods("stew-three", ["chickpeas", "tomatoes", "carrots", "cumin"]);
      mockFetchPage
        .mockResolvedValueOnce(page([stewThree], "11", true))
        .mockReturnValue(new Promise(() => undefined));
      const { result } = await startFeed();

      act(() => result.current.steer("less", stew));
      act(() => result.current.steer("more", stewToo));

      await waitFor(() =>
        expect(result.current.recipes.map((item) => item.recipe_id)).toContain(
          "stew-three",
        ),
      );
    });

    it("asks for one batch when More like this is pressed again before it lands", async () => {
      let finish: ((value: RecipeFeedResponse) => void) | undefined;
      mockFetchPage
        .mockImplementationOnce(
          () => new Promise<RecipeFeedResponse>((resolve) => { finish = resolve; }),
        )
        .mockReturnValue(new Promise(() => undefined));
      const { result } = await startFeed();

      act(() => result.current.steer("more", salmon));
      await waitFor(() => expect(mockFetchPage).toHaveBeenCalledTimes(1));
      act(() => result.current.steer("more", salmon));
      await act(async () => finish?.(page([salmonToo], "11", true)));

      await waitFor(() =>
        expect(result.current.recipes.map((item) => item.recipe_id)).toContain(
          "salmon-too",
        ),
      );
      expect(mockFetchPage).toHaveBeenCalledTimes(1);
    });

    it("forgets steering when a new feed starts", async () => {
      mockFetchPage.mockResolvedValue(page([], null, false));
      const { result } = await startFeed();
      act(() => result.current.steer("less", stew));

      mockCreateSession.mockResolvedValueOnce(page([salmon, ...head], "10", true));
      act(() => result.current.start(request));
      await waitFor(() => expect(result.current.recipes).toHaveLength(10));
      act(() => result.current.maybePrefetch(9));

      await waitFor(() => expect(mockFetchPage).toHaveBeenCalled());
      expect(mockFetchPage).toHaveBeenLastCalledWith(
        expect.objectContaining({ steering: undefined }),
      );
    });
  });
});
