import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen } from "@testing-library/react-native";
import RecipePhoto from "@/components/recipe-photo";
import type { ImageResult } from "@/types/images";

const mockFetchRecipeImage = jest.fn();

jest.mock("@/lib/supabase", () => ({ supabase: {} }));
jest.mock("@/lib/image-api", () => ({
  fetchRecipeImage: (...args: unknown[]) => mockFetchRecipeImage(...args),
}));
jest.mock("@expo/vector-icons/Feather", () => () => null);
jest.mock("@expo/vector-icons/FontAwesome", () => () => null);
jest.mock("@/hooks/useReducedMotion", () => ({ useReducedMotion: () => true }));

const ready: ImageResult = {
  status: "ready",
  image_key: "recipe:abc",
  url: "https://storage.test/abc.webp?token=1",
  expires_at: new Date(Date.now() + 3_600_000).toISOString(),
  reason: null,
};

function unavailable(reason: ImageResult["reason"]): ImageResult {
  return {
    ...ready,
    status: "unavailable",
    url: null,
    expires_at: null,
    reason,
  };
}

function renderPhoto(
  props: Partial<React.ComponentProps<typeof RecipePhoto>> = {},
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retryDelay: 0, gcTime: Infinity } },
  });
  return render(
    <QueryClientProvider client={client}>
      <RecipePhoto
        recipeId="r1"
        title="Spinach skillet"
        variant="sheet"
        {...props}
      />
    </QueryClientProvider>,
  );
}

beforeEach(() => mockFetchRecipeImage.mockReset());

it("shows the photo with a description", async () => {
  mockFetchRecipeImage.mockResolvedValue(ready);
  renderPhoto();
  const photo = await screen.findByLabelText("Photo of Spinach skillet");
  expect(photo.props.source).toEqual([
    expect.objectContaining({ uri: ready.url, cacheKey: "recipe:abc" }),
  ]);
});

it.each(["disabled", "budget_exhausted", "failed"] as const)(
  "shows the placeholder when the photo is unavailable (%s)",
  async (reason) => {
    mockFetchRecipeImage.mockResolvedValue(unavailable(reason));
    renderPhoto();
    expect(
      await screen.findByTestId("recipe-photo-placeholder", {
        includeHiddenElements: true,
      }),
    ).toBeTruthy();
    expect(screen.queryByLabelText(/Photo of/)).toBeNull();
  },
);

it("shows the loading placeholder while the photo is generated", async () => {
  mockFetchRecipeImage.mockReturnValue(new Promise(() => {}));
  renderPhoto();
  expect(
    screen.getByTestId("recipe-photo-loading", { includeHiddenElements: true }),
  ).toBeTruthy();
  expect(screen.queryByLabelText(/Photo of/)).toBeNull();
});

it("shows the placeholder when the request fails", async () => {
  mockFetchRecipeImage.mockRejectedValue(new Error("Network request failed"));
  renderPhoto();
  expect(
    await screen.findByTestId("recipe-photo-placeholder", {
      includeHiddenElements: true,
    }),
  ).toBeTruthy();
  expect(mockFetchRecipeImage).toHaveBeenCalledTimes(2);
  expect(
    screen.queryByTestId("recipe-photo-loading", {
      includeHiddenElements: true,
    }),
  ).toBeNull();
});

it("re-signs once when the image cannot load, then keeps the placeholder", async () => {
  const resigned = { ...ready, url: "https://storage.test/abc.webp?token=2" };
  mockFetchRecipeImage.mockResolvedValueOnce(ready).mockResolvedValue(resigned);
  renderPhoto();
  fireEvent(
    await screen.findByLabelText("Photo of Spinach skillet"),
    "error",
    { nativeEvent: { error: "403" } },
  );
  const retried = await screen.findByLabelText(
    "Photo of Spinach skillet",
  );
  expect(retried.props.source).toEqual([
    expect.objectContaining({ uri: resigned.url }),
  ]);
  fireEvent(retried, "error", { nativeEvent: { error: "404" } });
  expect(screen.queryByLabelText(/Photo of/)).toBeNull();
  expect(
    screen.getByTestId("recipe-photo-placeholder", {
      includeHiddenElements: true,
    }),
  ).toBeTruthy();
  await act(async () => {});
  expect(mockFetchRecipeImage).toHaveBeenCalledTimes(2);
});

it("waits to request the photo until enabled", async () => {
  mockFetchRecipeImage.mockResolvedValue(ready);
  const view = renderPhoto({ enabled: false });
  await act(async () => {});
  expect(mockFetchRecipeImage).not.toHaveBeenCalled();
  expect(
    screen.getByTestId("recipe-photo-placeholder", {
      includeHiddenElements: true,
    }),
  ).toBeTruthy();
  view.unmount();
});
