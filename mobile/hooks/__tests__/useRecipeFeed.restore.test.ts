import React from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanupAsync, renderHook, waitFor } from "@testing-library/react-native";
import type { ImageResult } from "@/types/images";
import type {
  RecipeFeedCard,
  RecipeFeedRestoreResponse,
  RecipeFeedSessionRequest,
  RecipePreferences,
  RecipeSuggestion,
} from "@/types/recipes";

const mockCreateSession = jest.fn();
const mockFetchPage = jest.fn();
const mockFetchLatest = jest.fn();
const mockLoadImage = jest.fn();

jest.mock("expo-image", () => ({
  Image: { loadAsync: (...args: unknown[]) => mockLoadImage(...args) },
}));

jest.mock("@/lib/recipe-feed-api", () => ({
  RECIPE_FEED_PAGE_SIZE: 5,
  RECIPE_FEED_REQUEST_TIMEOUT_MS: 56_000,
  createRecipeFeedSession: (...args: unknown[]) => mockCreateSession(...args),
  fetchRecipeFeedPage: (...args: unknown[]) => mockFetchPage(...args),
  fetchLatestRecipeFeed: (...args: unknown[]) => mockFetchLatest(...args),
}));

jest.mock("@/lib/supabase", () => ({ supabase: {} }));

import { useRecipeFeed } from "@/hooks/useRecipeFeed";

const request: RecipeFeedSessionRequest = {
  household_id: "household-1",
  preferences: { meal: "Dinner" },
};

function recipe(recipeId: string): RecipeSuggestion {
  return {
    recipe_id: recipeId,
    title: `Dish ${recipeId}`,
    cook_time_minutes: 30,
    servings: 2,
    ingredients: [],
    steps: ["Cook it"],
    match_percent: 90,
    saves_expiring: [],
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

function cards(...ids: string[]): RecipeFeedCard[] {
  return ids.map((id) => ({ ...recipe(id), image: photo(id) }));
}

function latest(
  recipes: RecipeFeedCard[],
  preferences: RecipePreferences = { meal: "Dinner" },
  sessionId = "session-1",
): RecipeFeedRestoreResponse {
  return {
    data: {
      session_id: sessionId,
      recipes,
      next_cursor: String(recipes.length),
      has_more: true,
      ready_count: recipes.length,
      empty_reason: null,
      requested_dish: "meal",
      preferences,
    },
  };
}

const ids = (recipes: readonly RecipeSuggestion[]) =>
  recipes.map((item) => item.recipe_id);

const queryClients: QueryClient[] = [];
const heldPhotos: (() => void)[] = [];

// Leaves the named cards' photo downloads running until `release` names them
// or the test ends. A download that never settled would hold every later
// test's photos behind the app's first download.
function holdPhotos(...recipeIds: string[]): { release: (id: string) => void } {
  const releases = new Map<string, () => void>();
  mockLoadImage.mockImplementation(({ uri }: { uri: string }) => {
    const loaded = { release: jest.fn() };
    const id = recipeIds.find((held) => uri.endsWith(`/${held}.webp`));
    if (!id) return Promise.resolve(loaded);
    return new Promise((resolve) => {
      const finish = () => resolve(loaded);
      releases.set(id, finish);
      heldPhotos.push(finish);
    });
  });
  return { release: (id) => releases.get(id)?.() };
}

function coldStart() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  queryClients.push(queryClient);
  return {
    queryClient,
    wrapper: ({ children }: { children: React.ReactNode }) =>
      React.createElement(QueryClientProvider, { client: queryClient }, children),
  };
}

describe("useRecipeFeed restore", () => {
  beforeEach(async () => {
    mockCreateSession.mockReset();
    mockFetchPage.mockReset();
    mockFetchLatest.mockReset();
    mockLoadImage.mockReset();
    mockLoadImage.mockResolvedValue({ release: jest.fn() });
    await AsyncStorage.clear();
  });

  afterEach(async () => {
    mockLoadImage.mockResolvedValue({ release: jest.fn() });
    heldPhotos.splice(0).forEach((finish) => finish());
    jest.restoreAllMocks();
    await cleanupAsync();
    for (const queryClient of queryClients) {
      for (const mutation of queryClient.getMutationCache().getAll()) mutation.destroy();
      queryClient.clear();
    }
    queryClients.length = 0;
  });

  it("shows the live session's cards in order without generating", async () => {
    mockFetchLatest.mockResolvedValue(latest(cards("a", "b", "c")));
    const onRestore = jest.fn();

    const app = coldStart();
    const { result } = renderHook(
      () => useRecipeFeed({ onSessionRestored: onRestore }),
      app,
    );

    expect(result.current.isRestoring).toBe(true);
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(ids(result.current.recipes)).toEqual(["a", "b", "c"]);
    expect(result.current.isRestoring).toBe(false);
    expect(onRestore).toHaveBeenCalledWith({ meal: "Dinner" });
    expect(app.queryClient.getQueryData(["recipe-image", "b"])).toEqual(photo("b"));
    expect(mockLoadImage).toHaveBeenCalledTimes(3);
    expect(mockCreateSession).not.toHaveBeenCalled();
    expect(mockFetchPage).not.toHaveBeenCalled();
  });

  it("shows the feed once the top card's photo is in, while the rest download", async () => {
    mockFetchLatest.mockResolvedValue(latest(cards("a", "b", "c")));
    const photos = holdPhotos("a", "b", "c");
    const { result } = renderHook(() => useRecipeFeed(), coldStart());
    await waitFor(() => expect(mockLoadImage).toHaveBeenCalled());
    await act(async () => {});
    expect(result.current.isRestoring).toBe(true);

    photos.release("a");

    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(ids(result.current.recipes)).toEqual(["a", "b", "c"]);
    await waitFor(() => expect(mockLoadImage).toHaveBeenCalledTimes(3));
  });

  it("waits on the first card left after a discard", async () => {
    mockFetchLatest.mockResolvedValue(latest(cards("a", "b", "c")));
    const first = renderHook(() => useRecipeFeed(), coldStart());
    await waitFor(() => expect(first.result.current.status).toBe("ready"));
    act(() => first.result.current.dismiss(["a"]));
    first.unmount();
    const photos = holdPhotos("b", "c");

    const second = renderHook(() => useRecipeFeed(), coldStart());
    await waitFor(() => expect(mockLoadImage).toHaveBeenCalledTimes(5));
    expect(second.result.current.isRestoring).toBe(true);
    photos.release("b");

    await waitFor(() => expect(second.result.current.status).toBe("ready"));
    expect(ids(second.result.current.recipes)).toEqual(["b", "c"]);
  });

  it("shows the feed without waiting when the top card has no photo", async () => {
    mockFetchLatest.mockResolvedValue(
      latest([{ ...recipe("a"), image: null }, ...cards("b", "c")]),
    );
    holdPhotos("b", "c");

    const { result } = renderHook(() => useRecipeFeed(), coldStart());

    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(ids(result.current.recipes)).toEqual(["a", "b", "c"]);
  });

  it.each([
    ["no live session", () => mockFetchLatest.mockResolvedValue({ data: null })],
    ["a failed read", () => mockFetchLatest.mockRejectedValue(new Error("offline"))],
  ])("stays idle after %s", async (_, arrange) => {
    arrange();
    jest.spyOn(console, "warn").mockImplementation(() => {});

    const { result } = renderHook(() => useRecipeFeed(), coldStart());

    await waitFor(() => expect(result.current.isRestoring).toBe(false));
    expect(result.current.status).toBe("idle");
    expect(result.current.recipes).toEqual([]);
  });

  it("waits for the cook to scroll before loading another page", async () => {
    mockFetchLatest.mockResolvedValue(latest(cards("a", "b", "c")));
    mockFetchPage.mockResolvedValue({
      data: { ...latest(cards("d")).data, next_cursor: null, has_more: false },
    });
    const { result } = renderHook(() => useRecipeFeed(), coldStart());
    await waitFor(() => expect(result.current.status).toBe("ready"));

    act(() => result.current.maybePrefetch(0));
    await act(async () => {});
    expect(mockFetchPage).not.toHaveBeenCalled();

    act(() => result.current.maybePrefetch(1));
    await waitFor(() => expect(ids(result.current.recipes)).toContain("d"));
    expect(mockFetchPage).toHaveBeenCalledTimes(1);
    expect(mockFetchPage.mock.calls[0][0]).toMatchObject({
      sessionId: "session-1",
      cursor: "3",
    });
  });

  it("loads more at once when every restored card is already in view", async () => {
    mockFetchLatest.mockResolvedValue(latest(cards("a")));
    mockFetchPage.mockResolvedValue({
      data: { ...latest(cards("b")).data, next_cursor: null, has_more: false },
    });
    const { result } = renderHook(() => useRecipeFeed(), coldStart());
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(mockFetchPage).not.toHaveBeenCalled();

    act(() => result.current.maybePrefetch(0));

    await waitFor(() => expect(ids(result.current.recipes)).toEqual(["a", "b"]));
    expect(mockFetchPage.mock.calls[0][0]).toMatchObject({ cursor: "1" });
  });

  it("keeps discarded and steered-away cards gone after a restart", async () => {
    mockFetchLatest.mockResolvedValue(latest(cards("a", "b", "c", "d")));
    mockFetchPage.mockResolvedValue({
      data: { ...latest([]).data, next_cursor: null, has_more: false },
    });
    const first = renderHook(() => useRecipeFeed(), coldStart());
    await waitFor(() => expect(first.result.current.status).toBe("ready"));
    act(() => first.result.current.dismiss(["b"]));
    act(() => first.result.current.steer("less", recipe("c")));
    act(() => first.result.current.dismiss(["c"]));
    await waitFor(() => expect(first.result.current.isExhausted).toBe(true));
    first.unmount();
    mockFetchPage.mockClear();

    const second = renderHook(() => useRecipeFeed(), coldStart());

    await waitFor(() => expect(second.result.current.status).toBe("ready"));
    expect(ids(second.result.current.recipes)).toEqual(["a", "d"]);
    act(() => second.result.current.maybePrefetch(0));
    act(() => second.result.current.maybePrefetch(1));
    await waitFor(() => expect(mockFetchPage).toHaveBeenCalledTimes(1));
    expect(mockFetchPage.mock.calls[0][0].steering).toEqual({
      more_like: [],
      less_like: ["c"],
    });
  });

  it("keeps cards that steering held back on arrival out after a restart", async () => {
    const withFoods = (id: string, foods: string[]): RecipeFeedCard => ({
      ...cards(id)[0],
      ingredients: foods.map((food) => ({
        name: food,
        inventory_item_id: food,
        use_amount: 1,
        unit: "each",
      })),
    });
    const stew = withFoods("stew", ["beef", "carrot"]);
    const alike = withFoods("alike", ["beef", "carrot"]);
    mockFetchLatest.mockResolvedValue(latest([cards("a")[0], stew]));
    mockFetchPage.mockResolvedValue({
      data: { ...latest([alike, ...cards("d")]).data, next_cursor: null, has_more: false },
    });
    const first = renderHook(() => useRecipeFeed(), coldStart());
    await waitFor(() => expect(first.result.current.status).toBe("ready"));
    act(() => first.result.current.steer("less", stew));
    act(() => first.result.current.dismiss(["stew"]));
    await waitFor(() => expect(ids(first.result.current.recipes)).toEqual(["a", "d"]));
    first.unmount();
    mockFetchLatest.mockResolvedValue(latest([cards("a")[0], stew, alike, ...cards("d")]));

    const second = renderHook(() => useRecipeFeed(), coldStart());

    await waitFor(() => expect(second.result.current.status).toBe("ready"));
    expect(ids(second.result.current.recipes)).toEqual(["a", "d"]);
  });

  it("brings back a card whose discard was undone", async () => {
    mockFetchLatest.mockResolvedValue(latest(cards("a", "b")));
    const first = renderHook(() => useRecipeFeed(), coldStart());
    await waitFor(() => expect(first.result.current.status).toBe("ready"));
    act(() => first.result.current.dismiss(["b"]));
    act(() => first.result.current.restore(["b"]));
    first.unmount();

    const second = renderHook(() => useRecipeFeed(), coldStart());

    await waitFor(() => expect(second.result.current.status).toBe("ready"));
    expect(ids(second.result.current.recipes)).toEqual(["a", "b"]);
  });

  it("stays idle when the cook had discarded every card", async () => {
    mockFetchLatest.mockResolvedValue(latest(cards("a")));
    const first = renderHook(() => useRecipeFeed(), coldStart());
    await waitFor(() => expect(first.result.current.status).toBe("ready"));
    act(() => first.result.current.dismiss(["a"]));
    first.unmount();

    const second = renderHook(() => useRecipeFeed(), coldStart());

    await waitFor(() => expect(second.result.current.isRestoring).toBe(false));
    expect(second.result.current.status).toBe("idle");
  });

  it("forgets discards from an older session", async () => {
    mockFetchLatest.mockResolvedValue(latest(cards("a", "b")));
    const first = renderHook(() => useRecipeFeed(), coldStart());
    await waitFor(() => expect(first.result.current.status).toBe("ready"));
    act(() => first.result.current.dismiss(["b"]));
    first.unmount();
    mockFetchLatest.mockResolvedValue(latest(cards("a", "b"), {}, "session-2"));

    const second = renderHook(() => useRecipeFeed(), coldStart());

    await waitFor(() => expect(second.result.current.status).toBe("ready"));
    expect(ids(second.result.current.recipes)).toEqual(["a", "b"]);
  });

  it("lets a session started during the restore win", async () => {
    let answer: ((value: RecipeFeedRestoreResponse) => void) | undefined;
    mockFetchLatest.mockReturnValue(
      new Promise<RecipeFeedRestoreResponse>((resolve) => { answer = resolve; }),
    );
    mockCreateSession.mockResolvedValue({
      data: { ...latest(cards("new")).data, session_id: "session-new" },
    });
    mockFetchPage.mockReturnValue(new Promise(() => {}));
    const onRestore = jest.fn();
    const { result } = renderHook(() => useRecipeFeed({ onSessionRestored: onRestore }), coldStart());

    act(() => result.current.start(request));
    await waitFor(() => expect(ids(result.current.recipes)).toEqual(["new"]));
    await act(async () => answer?.(latest(cards("old"))));

    expect(ids(result.current.recipes)).toEqual(["new"]);
    expect(result.current.isRestoring).toBe(false);
    expect(onRestore).not.toHaveBeenCalled();
  });
});
