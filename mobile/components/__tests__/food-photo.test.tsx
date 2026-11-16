import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen } from "@testing-library/react-native";
import FoodPhoto from "@/components/food-photo";
import type { ImageResult } from "@/types/images";

const mockFetchFoodImage = jest.fn();

jest.mock("@/lib/supabase", () => ({ supabase: {} }));
jest.mock("@/lib/image-api", () => ({
  fetchFoodImage: (...args: unknown[]) => mockFetchFoodImage(...args),
}));
jest.mock("@expo/vector-icons/FontAwesome", () => () => null);
jest.mock("@/hooks/useReducedMotion", () => ({ useReducedMotion: () => true }));

const ready: ImageResult = {
  status: "ready",
  image_key: "ingredient:tomato",
  url: "https://storage.test/tomato.webp?token=1",
  expires_at: new Date(Date.now() + 3_600_000).toISOString(),
  reason: null,
};

function renderPhoto(
  props: Partial<React.ComponentProps<typeof FoodPhoto>> = {},
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retryDelay: 0, gcTime: Infinity } },
  });
  return render(
    <QueryClientProvider client={client}>
      <FoodPhoto foodId="food-1" size={48} enabled {...props} />
    </QueryClientProvider>,
  );
}

beforeEach(() => mockFetchFoodImage.mockReset());

const findPhoto = () =>
  screen.findByTestId("food-photo-image", { includeHiddenElements: true });

it("shows the thumbnail, hidden from screen readers beside the food's name", async () => {
  mockFetchFoodImage.mockResolvedValue(ready);
  renderPhoto();
  const photo = await findPhoto();
  expect(photo.props.source).toEqual([
    expect.objectContaining({ uri: ready.url, cacheKey: "ingredient:tomato" }),
  ]);
  expect(screen.queryByTestId("food-photo-image")).toBeNull();
});

it.each(["disabled", "budget_exhausted", "failed"] as const)(
  "shows the placeholder when the thumbnail is unavailable (%s)",
  async (reason) => {
    mockFetchFoodImage.mockResolvedValue({
      ...ready,
      status: "unavailable",
      url: null,
      expires_at: null,
      reason,
    });
    renderPhoto();
    expect(
      await screen.findByTestId("food-photo-placeholder", {
        includeHiddenElements: true,
      }),
    ).toBeTruthy();
    expect(
      screen.queryByTestId("food-photo-image", { includeHiddenElements: true }),
    ).toBeNull();
  },
);

it("shows the loading placeholder while the thumbnail is generated", () => {
  mockFetchFoodImage.mockReturnValue(new Promise(() => {}));
  renderPhoto();
  expect(
    screen.getByTestId("food-photo-loading", { includeHiddenElements: true }),
  ).toBeTruthy();
});

it("keeps the placeholder for an ingredient with no food", async () => {
  renderPhoto({ foodId: null });
  await act(async () => {});
  expect(
    screen.getByTestId("food-photo-placeholder", {
      includeHiddenElements: true,
    }),
  ).toBeTruthy();
  expect(mockFetchFoodImage).not.toHaveBeenCalled();
});

it("asks for no thumbnail while disabled", async () => {
  mockFetchFoodImage.mockResolvedValue(ready);
  renderPhoto({ enabled: false });
  await act(async () => {});
  expect(mockFetchFoodImage).not.toHaveBeenCalled();
  expect(
    screen.getByTestId("food-photo-placeholder", {
      includeHiddenElements: true,
    }),
  ).toBeTruthy();
});

it("re-signs once when the image cannot load, then keeps the placeholder", async () => {
  const resigned = { ...ready, url: "https://storage.test/tomato.webp?token=2" };
  mockFetchFoodImage.mockResolvedValueOnce(ready).mockResolvedValue(resigned);
  renderPhoto();
  fireEvent(await findPhoto(), "error", { nativeEvent: { error: "403" } });
  const retried = await findPhoto();
  expect(retried.props.source).toEqual([
    expect.objectContaining({ uri: resigned.url }),
  ]);
  fireEvent(retried, "error", { nativeEvent: { error: "404" } });
  expect(
    screen.queryByTestId("food-photo-image", { includeHiddenElements: true }),
  ).toBeNull();
  expect(mockFetchFoodImage).toHaveBeenCalledTimes(2);
});
