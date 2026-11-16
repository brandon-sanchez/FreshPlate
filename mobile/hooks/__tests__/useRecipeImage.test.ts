import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react-native";
import { ApiError } from "@/lib/api";
import type { ImageResult } from "@/types/images";

const mockFetchRecipeImage = jest.fn();

jest.mock("@/lib/supabase", () => ({ supabase: {} }));

jest.mock("@/lib/image-api", () => ({
  fetchRecipeImage: (...args: unknown[]) => mockFetchRecipeImage(...args),
}));

import { useRecipeImage } from "@/hooks/useRecipeImage";

function ready(expiresInMs = 3_600_000): ImageResult {
  return {
    status: "ready",
    image_key: "recipe:abc",
    url: "https://storage.test/abc.webp?token=1",
    expires_at: new Date(Date.now() + expiresInMs).toISOString(),
    reason: null,
  };
}

const pending: ImageResult = {
  status: "pending",
  image_key: "recipe:abc",
  url: null,
  expires_at: null,
  reason: null,
};

function setup() {
  const client = new QueryClient({
    defaultOptions: { queries: { gcTime: Infinity, retryDelay: 0 } },
  });
  const wrapper = ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client }, children);
  return { client, wrapper };
}

beforeEach(() => {
  mockFetchRecipeImage.mockReset();
});

afterEach(() => {
  jest.useRealTimers();
});

it("shares one request between every view of a recipe", async () => {
  mockFetchRecipeImage.mockResolvedValue(ready());
  const { wrapper } = setup();
  const { result } = renderHook(
    () => [useRecipeImage("r1"), useRecipeImage("r1")],
    { wrapper },
  );
  await waitFor(() => expect(result.current[0].data?.status).toBe("ready"));
  expect(result.current[1].data?.image_key).toBe("recipe:abc");
  expect(mockFetchRecipeImage).toHaveBeenCalledTimes(1);
  expect(mockFetchRecipeImage.mock.calls[0][0]).toBe("r1");
});

it("makes no request while disabled", async () => {
  const { wrapper } = setup();
  const { result } = renderHook(
    () => useRecipeImage("r1", { enabled: false }),
    {
      wrapper,
    },
  );
  await act(async () => {});
  expect(result.current.fetchStatus).toBe("idle");
  expect(mockFetchRecipeImage).not.toHaveBeenCalled();
});

it("polls while another request generates the image", async () => {
  jest.useFakeTimers();
  mockFetchRecipeImage
    .mockResolvedValueOnce(pending)
    .mockResolvedValueOnce(ready());
  const { wrapper } = setup();
  const { result } = renderHook(() => useRecipeImage("r1"), { wrapper });
  await waitFor(() => expect(result.current.data?.status).toBe("pending"));
  await act(async () => {
    jest.advanceTimersByTime(5_000);
  });
  await waitFor(() => expect(result.current.data?.status).toBe("ready"));
  expect(mockFetchRecipeImage).toHaveBeenCalledTimes(2);
});

it("signs a fresh URL for a new view once the old one is about to expire", async () => {
  mockFetchRecipeImage
    .mockResolvedValueOnce(ready(30_000))
    .mockResolvedValueOnce(ready());
  const { wrapper } = setup();
  const first = renderHook(() => useRecipeImage("r1"), { wrapper });
  await waitFor(() => expect(first.result.current.data?.status).toBe("ready"));
  first.unmount();
  const second = renderHook(() => useRecipeImage("r1"), { wrapper });
  await waitFor(() => expect(second.result.current.isFetching).toBe(false));
  expect(mockFetchRecipeImage).toHaveBeenCalledTimes(2);
});

it("reuses a signed URL that is still valid", async () => {
  mockFetchRecipeImage.mockResolvedValue(ready());
  const { wrapper } = setup();
  const first = renderHook(() => useRecipeImage("r1"), { wrapper });
  await waitFor(() => expect(first.result.current.data?.status).toBe("ready"));
  first.unmount();
  const second = renderHook(() => useRecipeImage("r1"), { wrapper });
  expect(second.result.current.data?.status).toBe("ready");
  await act(async () => {});
  expect(mockFetchRecipeImage).toHaveBeenCalledTimes(1);
});

it("does not retry a recipe the caller cannot see", async () => {
  mockFetchRecipeImage.mockRejectedValue(
    new ApiError(404, "Image subject not found", "IMAGE_SUBJECT_NOT_FOUND"),
  );
  const { wrapper } = setup();
  const { result } = renderHook(() => useRecipeImage("r1"), { wrapper });
  await waitFor(() => expect(result.current.isError).toBe(true));
  expect(mockFetchRecipeImage).toHaveBeenCalledTimes(1);
});

it("retries a server error once", async () => {
  mockFetchRecipeImage
    .mockRejectedValueOnce(
      new ApiError(503, "Image service unavailable", "IMAGE_UNAVAILABLE"),
    )
    .mockResolvedValueOnce(ready());
  const { wrapper } = setup();
  const { result } = renderHook(() => useRecipeImage("r1"), { wrapper });
  await waitFor(() => expect(result.current.data?.status).toBe("ready"));
  expect(mockFetchRecipeImage).toHaveBeenCalledTimes(2);
});

it("keeps an unavailable result for 15 minutes", async () => {
  mockFetchRecipeImage.mockResolvedValue({
    ...pending,
    status: "unavailable",
    reason: "budget_exhausted",
  });
  const { wrapper } = setup();
  const first = renderHook(() => useRecipeImage("r1"), { wrapper });
  await waitFor(() =>
    expect(first.result.current.data?.status).toBe("unavailable"),
  );
  first.unmount();
  const now = Date.now();
  const clock = jest.spyOn(Date, "now").mockReturnValue(now + 14 * 60_000);
  const second = renderHook(() => useRecipeImage("r1"), { wrapper });
  await act(async () => {});
  expect(mockFetchRecipeImage).toHaveBeenCalledTimes(1);
  second.unmount();
  clock.mockReturnValue(now + 16 * 60_000);
  const third = renderHook(() => useRecipeImage("r1"), { wrapper });
  await waitFor(() => expect(mockFetchRecipeImage).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(third.result.current.isFetching).toBe(false));
  clock.mockRestore();
});

it("asks again about a minute after a photo that missed the feed's deadline", async () => {
  const late: ImageResult = { ...pending, status: "unavailable", reason: "late" };
  mockFetchRecipeImage.mockResolvedValue(ready());
  const { client, wrapper } = setup();
  client.setQueryData(["recipe-image", "r1"], late);
  const now = Date.now();
  const clock = jest.spyOn(Date, "now").mockReturnValue(now + 30_000);
  const first = renderHook(() => useRecipeImage("r1"), { wrapper });
  await act(async () => {});
  expect(mockFetchRecipeImage).not.toHaveBeenCalled();
  first.unmount();
  clock.mockReturnValue(now + 61_000);
  const second = renderHook(() => useRecipeImage("r1"), { wrapper });
  await waitFor(() => expect(second.result.current.data?.status).toBe("ready"));
  expect(mockFetchRecipeImage).toHaveBeenCalledTimes(1);
  clock.mockRestore();
});
