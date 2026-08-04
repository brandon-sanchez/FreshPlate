import React from "react";
import { renderHook, waitFor } from "@testing-library/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const mockGetSession = jest.fn().mockResolvedValue({
  data: { session: { access_token: "test-token" } },
});

jest.mock("@/lib/supabase", () => ({
  supabase: { auth: { getSession: () => mockGetSession() } },
}));

import { useRecipeSuggestions } from "@/hooks/useRecipeSuggestions";
import type { RecipeSuggestionRequest } from "@/types/recipes";

function wrapper({ children }: { children: React.ReactNode }) {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false, gcTime: 0 },
    },
  });
  return React.createElement(QueryClientProvider, { client }, children);
}

const request: RecipeSuggestionRequest = {
  inventory: [
    {
      id: "spinach",
      name: "Baby Spinach",
      quantity: 1,
      unit: "bag",
      expiration_date: "2026-08-06",
    },
  ],
  preferences: {
    meal: "Dinner",
    time: "<30 min",
    occasion: "date night",
  },
  exclude_titles: [],
  batch_ceiling: 8,
};

const originalFetch = global.fetch;

describe("useRecipeSuggestions", () => {
  beforeEach(() => {
    mockGetSession.mockClear();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("forwards session preferences and inventory to the suggestion endpoint", async () => {
    const fetchSpy = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      text: () =>
        Promise.resolve(
          JSON.stringify({ data: { recipes: [] } }),
        ),
    });
    global.fetch = fetchSpy as unknown as typeof fetch;

    const { result } = renderHook(() => useRecipeSuggestions(), { wrapper });
    result.current.mutate(request);

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringMatching(/\/api\/recipes\/suggestions$/),
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify(request),
      }),
    );
    const headers = fetchSpy.mock.calls[0][1].headers as Headers;
    expect(headers.get("authorization")).toBe("Bearer test-token");
    expect(headers.get("content-type")).toBe("application/json");
    expect(result.current.data).toEqual({ data: { recipes: [] } });
  });

  it("surfaces an unavailable response as a mutation error", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 503,
      statusText: "Service Unavailable",
      text: () =>
        Promise.resolve(
          JSON.stringify({
            error: "AI service unavailable",
            code: "AI_UNAVAILABLE",
          }),
        ),
    }) as unknown as typeof fetch;

    const { result } = renderHook(() => useRecipeSuggestions(), { wrapper });
    result.current.mutate(request);

    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(result.current.error?.message).toBe("AI service unavailable");
    expect(result.current.error).toMatchObject({
      status: 503,
      code: "AI_UNAVAILABLE",
    });
  });
});
