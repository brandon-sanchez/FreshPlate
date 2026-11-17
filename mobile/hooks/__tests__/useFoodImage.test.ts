import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react-native";
import { ApiError } from "@/lib/api";
import type { ImageResult } from "@/types/images";

const mockFetchFoodImage = jest.fn();

jest.mock("@/lib/supabase", () => ({ supabase: {} }));

jest.mock("@/lib/image-api", () => ({
  fetchFoodImage: (...args: unknown[]) => mockFetchFoodImage(...args),
}));

import { useFoodImage } from "@/hooks/useFoodImage";

const ready: ImageResult = {
  status: "ready",
  image_key: "ingredient:tomato",
  url: "https://storage.test/tomato.webp?token=1",
  expires_at: new Date(Date.now() + 3_600_000).toISOString(),
  reason: null,
};

function setup() {
  const client = new QueryClient({
    defaultOptions: { queries: { gcTime: Infinity, retryDelay: 0 } },
  });
  const wrapper = ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client }, children);
  return { wrapper };
}

beforeEach(() => {
  mockFetchFoodImage.mockReset();
});

it("shares one request between every view of a food", async () => {
  mockFetchFoodImage.mockResolvedValue(ready);
  const { wrapper } = setup();
  const { result } = renderHook(
    () => [useFoodImage("food-1"), useFoodImage("food-1")],
    { wrapper },
  );
  await waitFor(() => expect(result.current[0].data?.status).toBe("ready"));
  expect(result.current[1].data?.image_key).toBe("ingredient:tomato");
  expect(mockFetchFoodImage).toHaveBeenCalledTimes(1);
  expect(mockFetchFoodImage.mock.calls[0][0]).toBe("food-1");
});

it("makes no request while disabled", async () => {
  const { wrapper } = setup();
  const { result } = renderHook(
    () => useFoodImage("food-1", { enabled: false }),
    { wrapper },
  );
  await act(async () => {});
  expect(result.current.fetchStatus).toBe("idle");
  expect(mockFetchFoodImage).not.toHaveBeenCalled();
});

it("makes no request for an ingredient with no food", async () => {
  const { wrapper } = setup();
  const { result } = renderHook(() => useFoodImage(null), { wrapper });
  await act(async () => {});
  expect(result.current.fetchStatus).toBe("idle");
  expect(mockFetchFoodImage).not.toHaveBeenCalled();
});

it("does not retry a food the caller cannot see", async () => {
  mockFetchFoodImage.mockRejectedValue(
    new ApiError(404, "Image subject not found", "IMAGE_SUBJECT_NOT_FOUND"),
  );
  const { wrapper } = setup();
  const { result } = renderHook(() => useFoodImage("food-1"), { wrapper });
  await waitFor(() => expect(result.current.isError).toBe(true));
  expect(mockFetchFoodImage).toHaveBeenCalledTimes(1);
});

it("keeps an over-budget result instead of asking again", async () => {
  mockFetchFoodImage.mockResolvedValue({
    ...ready,
    status: "unavailable",
    url: null,
    expires_at: null,
    reason: "budget_exhausted",
  });
  const { wrapper } = setup();
  const first = renderHook(() => useFoodImage("food-1"), { wrapper });
  await waitFor(() =>
    expect(first.result.current.data?.status).toBe("unavailable"),
  );
  first.unmount();
  renderHook(() => useFoodImage("food-1"), { wrapper });
  await act(async () => {});
  expect(mockFetchFoodImage).toHaveBeenCalledTimes(1);
});
