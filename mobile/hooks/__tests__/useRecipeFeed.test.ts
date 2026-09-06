import React from "react";
import {
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react-native";
import type {
  RecipeFeedResponse,
  RecipeFeedSessionRequest,
  RecipeSuggestion,
} from "@/types/recipes";

const mockCreateSession = jest.fn();
const mockFetchPage = jest.fn();

jest.mock("@/lib/recipe-feed-api", () => ({
  RECIPE_FEED_PAGE_SIZE: 5,
  RECIPE_FEED_REQUEST_TIMEOUT_MS: 35_000,
  createRecipeFeedSession: (...args: unknown[]) => mockCreateSession(...args),
  fetchRecipeFeedPage: (...args: unknown[]) => mockFetchPage(...args),
}));

import { useRecipeFeed } from "@/hooks/useRecipeFeed";

const request: RecipeFeedSessionRequest = {
  inventory: [
    {
      id: "spinach",
      name: "Baby Spinach",
      quantity: 1,
      unit: "bag",
      expiration_date: "2026-08-06",
    },
  ],
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
  recipes: RecipeSuggestion[],
  nextCursor: string | null,
  hasMore: boolean,
  readyCount = recipes.length,
): RecipeFeedResponse {
  return {
    data: {
      session_id: "session-1",
      recipes,
      next_cursor: nextCursor,
      has_more: hasMore,
      ready_count: readyCount,
      empty_reason: null,
    },
  };
}

function wrapper({ children }: { children: React.ReactNode }) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return React.createElement(
    QueryClientProvider,
    { client: queryClient },
    children,
  );
}

describe("useRecipeFeed", () => {
  beforeEach(() => {
    mockCreateSession.mockReset();
    mockFetchPage.mockReset();
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

  it.each([1_000, 25_000, 35_000])(
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

    act(() => result.current.dismiss("recipe-1"));
    await waitFor(() =>
      expect(result.current.recipes.map((item) => item.title)).toEqual(["Soup"]),
    );
    expect(result.current.isExhausted).toBe(true);
  });
});
