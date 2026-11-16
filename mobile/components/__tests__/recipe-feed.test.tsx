import React from "react";
import * as ReactNative from "react-native";
import {
  act,
  cleanup,
  fireEvent,
  render as renderNative,
  within,
} from "@testing-library/react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { State } from "react-native-gesture-handler";
import {
  fireGestureHandler,
  getByGestureTestId,
} from "react-native-gesture-handler/jest-utils";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { RecipeSuggestion } from "@/types/recipes";

const mockFetchRecipeImage = jest.fn();
jest.mock("@/lib/supabase", () => ({ supabase: {} }));
jest.mock("@/lib/image-api", () => ({
  fetchRecipeImage: (...args: unknown[]) => mockFetchRecipeImage(...args),
}));

const mockReducedMotion = jest.fn(() => false);
jest.mock("@/hooks/useReducedMotion", () => ({
  useReducedMotion: () => mockReducedMotion(),
}));

jest.mock("@expo/vector-icons/Feather", () => {
  const MockIcon = () => null;
  return MockIcon;
});

jest.mock("@expo/vector-icons/FontAwesome", () => {
  const MockIcon = () => null;
  return MockIcon;
});

import RecipeFeed from "@/components/recipe-feed";
import { motionDuration, motionStagger } from "@/constants/motion";

function render(ui: React.ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  return renderNative(ui, {
    wrapper: ({ children }) => (
      <QueryClientProvider client={client}>
        <SafeAreaProvider
          initialMetrics={{
            frame: { x: 0, y: 0, width: 390, height: 844 },
            insets: { top: 44, right: 0, bottom: 34, left: 0 },
          }}
        >
          {children}
        </SafeAreaProvider>
      </QueryClientProvider>
    ),
  });
}

const baseRecipe: RecipeSuggestion = {
  recipe_id: "recipe-1",
  title: "Spinach Pasta",
  cook_time_minutes: 24,
  servings: 2,
  ingredients: [
    {
      name: "Spinach",
      inventory_item_id: "spinach",
      use_amount: 100,
      unit: "g",
    },
    { name: "Pasta", inventory_item_id: "pasta", use_amount: 200, unit: "g" },
  ],
  steps: ["Cook it"],
  match_percent: 92,
  saves_expiring: ["Baby Spinach"],
};

function withFoods(recipeId: string, foods: string[]): RecipeSuggestion {
  return {
    ...baseRecipe,
    recipe_id: recipeId,
    title: recipeId,
    ingredients: foods.map((food) => ({
      name: food,
      inventory_item_id: food,
      use_amount: 1,
      unit: "each",
    })),
  };
}

const sweepFeed = [
  withFoods("alike-above", ["salmon", "rice", "lemon"]),
  withFoods("chosen", ["salmon", "rice", "lemon", "peas"]),
  withFoods("unalike", ["chickpeas", "tomatoes", "carrots"]),
  withFoods("alike", ["salmon", "rice", "lemon", "garlic"]),
  withFoods("unalike-too", ["eggs", "spaghetti", "parmesan"]),
];

function expectRenderedLeaving(
  screen: ReturnType<typeof render>,
  ids: string[],
) {
  const leaving = screen
    .queryAllByTestId("recipe-sweep-leaving", { includeHiddenElements: true })
    .map((wrapper) =>
      within(wrapper)
        .getAllByTestId(/^recipe-card-open-/, { includeHiddenElements: true })
        .map((card) =>
          String(card.props.testID).replace("recipe-card-open-", ""),
        ),
    )
    .flat();
  expect(leaving).toEqual(ids);
}

const SWEEP_OF_TWO_MS = motionStagger.sweep + motionDuration.fast;

const defaultProps = {
  itemCount: 4,
  preferences: {},
  isPrefetching: false,
  prefetchError: null,
  isExhausted: false,
  topInset: 0,
  bottomInset: 24,
  onAsk: jest.fn(),
  onDismiss: jest.fn(),
  onSteer: jest.fn(),
  onNearEnd: jest.fn(),
  onRetryMore: jest.fn(),
  onAddItems: jest.fn(),
  onEditAnswers: jest.fn(),
  onCook: jest.fn(),
};

describe("RecipeFeed", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    ReactNative.Dimensions.set({
      window: { width: 390, height: 844, scale: 3, fontScale: 1 },
      screen: { width: 390, height: 844, scale: 3, fontScale: 1 },
    });
    mockReducedMotion.mockReturnValue(false);
    mockFetchRecipeImage.mockReset();
    mockFetchRecipeImage.mockReturnValue(new Promise(() => {}));
  });

  afterEach(() => {
    cleanup();
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it("keeps bookmarking and touch release separate from opening a preview", () => {
    mockReducedMotion.mockReturnValue(true);
    const onToggleSave = jest.fn();
    const screen = render(
      <RecipeFeed
        {...defaultProps}
        recipes={[baseRecipe]}
        onToggleSave={onToggleSave}
      />,
    );
    fireEvent.press(screen.getByTestId("recipe-card-save-recipe-1"));
    expect(onToggleSave).toHaveBeenCalledWith(baseRecipe, false);
    expect(screen.queryByLabelText("View full recipe")).toBeNull();
    fireEvent(screen.getByTestId("recipe-card-open-recipe-1"), "touchEnd");
    expect(screen.queryByLabelText("View full recipe")).toBeNull();
    fireEvent.press(screen.getByTestId("recipe-card-open-recipe-1"));
    expect(screen.getByLabelText("View full recipe")).toBeTruthy();
  });

  it("starts cooking on a full right swipe and ignores a short one", () => {
    const onCook = jest.fn();
    render(
      <RecipeFeed {...defaultProps} recipes={[baseRecipe]} onCook={onCook} />,
    );
    const swipe = getByGestureTestId("recipe-card-cook-swipe-recipe-1");
    fireGestureHandler(swipe, [
      { state: State.BEGAN, translationX: 0 },
      { state: State.ACTIVE, translationX: 40 },
      { state: State.END, translationX: 60 },
    ]);
    expect(onCook).not.toHaveBeenCalled();
    fireGestureHandler(swipe, [
      { state: State.BEGAN, translationX: 0 },
      { state: State.ACTIVE, translationX: 80 },
      { state: State.END, translationX: 140 },
    ]);
    expect(onCook).toHaveBeenCalledWith(baseRecipe);
  });

  it("closes the preview sheet when cooking starts from it", () => {
    mockReducedMotion.mockReturnValue(true);
    const onCook = jest.fn();
    const screen = render(
      <RecipeFeed {...defaultProps} recipes={[baseRecipe]} onCook={onCook} />,
    );
    fireEvent.press(screen.getByTestId("recipe-card-preview-recipe-1"));
    fireEvent.press(screen.getByTestId("recipe-preview-cook"));
    expect(onCook).toHaveBeenCalledWith(baseRecipe);
    expect(screen.queryByTestId("recipe-preview-cook")).toBeNull();
  });

  it("does not count offscreen cards as consumed when the list nears its end", () => {
    const onNearEnd = jest.fn();
    const { getByTestId } = render(
      <RecipeFeed
        {...defaultProps}
        onNearEnd={onNearEnd}
        recipes={Array.from({ length: 5 }, (_, index) => ({
          ...baseRecipe,
          recipe_id: `${index}`,
        }))}
      />,
    );
    fireEvent(getByTestId("recipe-feed-list"), "viewableItemsChanged", {
      viewableItems: [{ index: 0 }, { index: 1 }],
    });
    fireEvent(getByTestId("recipe-feed-list"), "endReached");
    expect(onNearEnd).toHaveBeenLastCalledWith(1);
  });

  it("starts an unseen card in its entry pose rather than flashing it fully visible", () => {
    const { getByTestId } = render(
      <RecipeFeed {...defaultProps} recipes={[baseRecipe]} />,
    );
    expect(getByTestId("recipe-card-recipe-1")).toHaveStyle({ opacity: 0.45 });
  });

  it("sweeps with a short plain fade when Reduce Motion is on", () => {
    mockReducedMotion.mockReturnValue(true);
    const onDismiss = jest.fn();
    const screen = render(
      <RecipeFeed
        {...defaultProps}
        onDismiss={onDismiss}
        recipes={sweepFeed}
      />,
    );

    fireEvent.press(screen.getByTestId("recipe-card-more-like-this-chosen"));
    expectRenderedLeaving(screen, ["unalike"]);
    const [wrapper] = screen.getAllByTestId("recipe-sweep-leaving", {
      includeHiddenElements: true,
    });
    expect(wrapper).toHaveStyle({ transform: [] });
    act(() => jest.advanceTimersByTime(79));
    expect(onDismiss).not.toHaveBeenCalled();
    act(() => jest.advanceTimersByTime(1));

    expect(onDismiss).toHaveBeenCalledWith(["unalike", "unalike-too"]);
  });

  it("sweeps unalike cards below for More like this and keeps alike ones", () => {
    const onDismiss = jest.fn();
    const onSteer = jest.fn();
    const screen = render(
      <RecipeFeed
        {...defaultProps}
        onDismiss={onDismiss}
        onSteer={onSteer}
        recipes={sweepFeed}
      />,
    );

    fireEvent.press(screen.getByTestId("recipe-card-more-like-this-chosen"));

    expect(onSteer).toHaveBeenCalledWith("more", sweepFeed[1]);
    expectRenderedLeaving(screen, ["unalike"]);
    act(() => jest.advanceTimersByTime(SWEEP_OF_TWO_MS - 1));
    expect(onDismiss).not.toHaveBeenCalled();
    act(() => jest.advanceTimersByTime(1));
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onDismiss).toHaveBeenCalledWith(["unalike", "unalike-too"]);
  });

  it("sweeps the card and alike cards below for Less like this", () => {
    const onDismiss = jest.fn();
    const onSteer = jest.fn();
    const screen = render(
      <RecipeFeed
        {...defaultProps}
        onDismiss={onDismiss}
        onSteer={onSteer}
        recipes={sweepFeed}
      />,
    );

    fireEvent.press(screen.getByTestId("recipe-card-less-like-this-chosen"));
    expectRenderedLeaving(screen, ["chosen", "alike"]);
    act(() => jest.advanceTimersByTime(SWEEP_OF_TWO_MS));

    expect(onSteer).toHaveBeenCalledWith("less", sweepFeed[1]);
    expect(onDismiss).toHaveBeenCalledWith(["chosen", "alike"]);
  });

  it("keeps the cards below when no steered batch can load", () => {
    const onDismiss = jest.fn();
    const onSteer = jest.fn();
    const screen = render(
      <RecipeFeed
        {...defaultProps}
        isExhausted
        onDismiss={onDismiss}
        onSteer={onSteer}
        recipes={sweepFeed}
      />,
    );

    fireEvent.press(screen.getByTestId("recipe-card-more-like-this-chosen"));
    act(() => jest.runOnlyPendingTimers());

    expect(onSteer).toHaveBeenCalledWith("more", sweepFeed[1]);
    expectRenderedLeaving(screen, []);
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("commits a running sweep when the feed unmounts", () => {
    const onDismiss = jest.fn();
    const { getByTestId, unmount } = render(
      <RecipeFeed
        {...defaultProps}
        onDismiss={onDismiss}
        recipes={sweepFeed}
      />,
    );

    fireEvent.press(getByTestId("recipe-card-less-like-this-chosen"));
    unmount();

    expect(onDismiss).toHaveBeenCalledWith(["chosen", "alike"]);
  });
  it("shows an honest loading tail while existing recipes stay scrollable", () => {
    const { getByTestId, getByText, queryByText } = render(
      <RecipeFeed {...defaultProps} isPrefetching recipes={[baseRecipe]} />,
    );
    expect(getByTestId("recipe-feed-loading")).toBeTruthy();
    expect(getByText("Spinach Pasta")).toBeTruthy();
    expect(queryByText("That's all for now")).toBeNull();
  });
  it("renders the card contract", () => {
    const { getByTestId, getByText, getByLabelText } = render(
      <RecipeFeed {...defaultProps} recipes={[baseRecipe]} />,
    );

    expect(getByText("Spinach Pasta")).toBeTruthy();
    expect(getByTestId("recipe-stats")).toHaveTextContent("24 minTime2Serves");
    expect(getByLabelText("Less like this: Spinach Pasta")).toBeTruthy();
    expect(getByLabelText("More like this: Spinach Pasta")).toBeTruthy();
    fireEvent(getByTestId("recipe-card-teaser-recipe-1"), "layout", {
      nativeEvent: { layout: { x: 0, y: 0, width: 300, height: 80 } },
    });
    expect(getByText("Uses up Baby Spinach")).toBeTruthy();
  });

  it("announces the card as one control that opens the preview", () => {
    const screen = render(
      <RecipeFeed {...defaultProps} recipes={[baseRecipe]} />,
    );
    const summary = screen.getByTestId("recipe-card-preview-recipe-1");
    expect(summary.props.accessibilityRole).toBe("button");
    expect(summary.props.accessibilityLabel).toBe(
      "Spinach Pasta. 24 minutes, serves 2. Uses up Baby Spinach",
    );
    expect(summary.props.accessibilityHint).toBe("Opens the recipe preview");
    fireEvent(summary, "accessibilityTap");
    expect(screen.getByLabelText("View full recipe")).toBeTruthy();
  });

  it("claims touches around the card's buttons so a disabled tap never opens the preview", () => {
    const screen = render(
      <RecipeFeed {...defaultProps} recipes={[baseRecipe]} isSavePending />,
    );
    const nearestResponder = (testID: string) => {
      let node = screen.getByTestId(testID).parent;
      while (
        node &&
        (node.props.testID === testID || !node.props.onStartShouldSetResponder)
      ) {
        node = node.parent;
      }
      return node;
    };
    for (const testID of [
      "recipe-card-save-recipe-1",
      "recipe-card-less-like-this-recipe-1",
    ]) {
      const claimer = nearestResponder(testID);
      expect(claimer?.props.testID).not.toBe("recipe-card-open-recipe-1");
      expect(claimer?.props.onStartShouldSetResponder()).toBe(true);
    }
  });

  it("sends More like this to its handler without opening or removing the card", () => {
    mockReducedMotion.mockReturnValue(true);
    const onSteer = jest.fn();
    const onDismiss = jest.fn();
    const screen = render(
      <RecipeFeed
        {...defaultProps}
        onSteer={onSteer}
        onDismiss={onDismiss}
        recipes={[baseRecipe]}
      />,
    );
    fireEvent.press(screen.getByTestId("recipe-card-more-like-this-recipe-1"));
    act(() => jest.runOnlyPendingTimers());
    expect(onSteer).toHaveBeenCalledWith("more", baseRecipe);
    expect(onDismiss).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("View full recipe")).toBeNull();
  });

  it("keeps only the teaser lines that fit, with the Uses up line first", () => {
    const screen = render(
      <RecipeFeed {...defaultProps} recipes={[baseRecipe]} />,
    );
    const layout = (height: number) =>
      fireEvent(screen.getByTestId("recipe-card-teaser-recipe-1"), "layout", {
        nativeEvent: { layout: { x: 0, y: 0, width: 300, height } },
      });
    layout(20);
    expect(screen.getByText("Uses up Baby Spinach")).toBeTruthy();
    expect(screen.queryByText(/Spinach · Pasta/)).toBeNull();
    layout(45);
    expect(screen.getByText(/Spinach · Pasta/).props.numberOfLines).toBe(1);
    layout(10);
    expect(screen.queryByText("Uses up Baby Spinach")).toBeNull();
  });

  it("shows the recipe photo on the card and reuses it in the preview", async () => {
    jest.useRealTimers();
    mockFetchRecipeImage.mockResolvedValue({
      status: "ready",
      image_key: "recipe:spinach",
      url: "https://storage.test/spinach.webp?token=1",
      expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      reason: null,
    });
    const screen = render(
      <RecipeFeed {...defaultProps} recipes={[baseRecipe]} />,
    );
    fireEvent(screen.getByTestId("recipe-feed-viewport"), "layout", {
      nativeEvent: { layout: { x: 0, y: 0, width: 390, height: 650 } },
    });
    expect(
      await screen.findAllByLabelText("Photo of Spinach Pasta"),
    ).toHaveLength(1);
    fireEvent.press(screen.getByTestId("recipe-card-open-recipe-1"));
    expect(screen.getAllByLabelText("Photo of Spinach Pasta")).toHaveLength(2);
    expect(mockFetchRecipeImage).toHaveBeenCalledTimes(1);
  });

  it("requests photos only for the active card and its neighbor", async () => {
    const screen = render(
      <RecipeFeed
        {...defaultProps}
        recipes={Array.from({ length: 5 }, (_, index) => ({
          ...baseRecipe,
          recipe_id: `recipe-${index + 1}`,
        }))}
      />,
    );
    fireEvent(screen.getByTestId("recipe-feed-viewport"), "layout", {
      nativeEvent: { layout: { x: 0, y: 0, width: 390, height: 650 } },
    });
    await act(async () => {});
    expect(mockFetchRecipeImage.mock.calls.map(([id]) => id).sort()).toEqual([
      "recipe-1",
      "recipe-2",
    ]);
  });

  it("keeps all recipes in the virtualized carousel", () => {
    const { getByTestId } = render(
      <RecipeFeed
        {...defaultProps}
        recipes={Array.from({ length: 8 }, (_, index) => ({
          ...baseRecipe,
          recipe_id: `recipe-${index + 1}`,
          title: `Spinach Pasta ${index + 1}`,
        }))}
      />,
    );

    const list = getByTestId("recipe-feed-list");
    expect(list.props.data).toHaveLength(8);
    expect(list.props.initialNumToRender).toBe(4);
    expect(list.props.maxToRenderPerBatch).toBe(4);
  });

  it("allows free scrolling to card actions when the viewport cannot fit a card", () => {
    const { getByTestId } = render(
      <RecipeFeed {...defaultProps} recipes={[baseRecipe]} />,
    );
    const layout = (height: number) =>
      fireEvent(getByTestId("recipe-feed-viewport"), "layout", {
        nativeEvent: { layout: { x: 0, y: 0, width: 390, height } },
      });
    layout(650);
    expect(getByTestId("recipe-carousel")).toBeTruthy();
    layout(420);
    expect(
      getByTestId("recipe-feed-list").props.snapToInterval,
    ).toBeUndefined();
    expect(getByTestId("recipe-feed-list").props.decelerationRate).toBe(
      "normal",
    );
    fireEvent.press(getByTestId("recipe-card-open-recipe-1"));
    expect(getByTestId("recipe-ingredients-list")).toBeTruthy();
  });

  it("shrinks the stacked card to fit a viewport shortened by the cooking banner", () => {
    const { getByTestId } = render(
      <RecipeFeed {...defaultProps} recipes={[baseRecipe]} />,
    );
    const layout = (height: number) =>
      fireEvent(getByTestId("recipe-feed-viewport"), "layout", {
        nativeEvent: { layout: { x: 0, y: 0, width: 390, height } },
      });
    const slotHeight = () =>
      ReactNative.StyleSheet.flatten(
        getByTestId("recipe-carousel-slot-0").props.style,
      ).height;

    layout(650);
    expect(slotHeight()).toBe(420);
    layout(494);
    expect(getByTestId("recipe-carousel")).toBeTruthy();
    expect(slotHeight()).toBe(410);
  });

  it("shows a refill issue on the feed background as an alert, not a card", () => {
    const { getByRole, getByTestId } = render(
      <RecipeFeed
        {...defaultProps}
        recipes={[baseRecipe]}
        prefetchError={new Error("AI unavailable")}
      />,
    );

    expect(getByRole("alert")).toHaveProp(
      "accessibilityLabel",
      "We couldn't load more recipes right now.",
    );
    expect(getByTestId("recipe-feed-error")).not.toHaveStyle({
      backgroundColor: expect.anything(),
    });
  });

  it("shows the ingredients on the card and all amounts in the sheet", () => {
    const { getByTestId, getByText, queryByTestId } = render(
      <RecipeFeed {...defaultProps} recipes={[baseRecipe]} />,
    );
    fireEvent(getByTestId("recipe-card-teaser-recipe-1"), "layout", {
      nativeEvent: { layout: { x: 0, y: 0, width: 300, height: 80 } },
    });
    expect(getByText(/Spinach · Pasta/)).toBeTruthy();
    fireEvent.press(getByTestId("recipe-card-open-recipe-1"));
    expect(getByText("100 g")).toBeTruthy();
    expect(getByText("200 g")).toBeTruthy();
    fireEvent.press(getByTestId("recipe-ingredients-close"));
    expect(queryByTestId("recipe-ingredients-list")).toBeNull();
  });

  it("offers add-items and edit-answers actions at honest exhaustion", () => {
    const onAddItems = jest.fn();
    const onEditAnswers = jest.fn();
    const { getByTestId } = render(
      <RecipeFeed
        {...defaultProps}
        onAddItems={onAddItems}
        onEditAnswers={onEditAnswers}
        isExhausted
        recipes={[]}
      />,
    );

    fireEvent.press(getByTestId("recipe-feed-add-items"));
    fireEvent.press(getByTestId("recipe-feed-edit-answers"));

    expect(onAddItems).toHaveBeenCalledTimes(1);
    expect(onEditAnswers).toHaveBeenCalledTimes(1);
  });

  it("uses the latest low-water callback after the feed grows", () => {
    const firstNearEnd = jest.fn();
    const latestNearEnd = jest.fn();
    const { getByTestId, rerender } = render(
      <RecipeFeed
        {...defaultProps}
        onNearEnd={firstNearEnd}
        recipes={[baseRecipe]}
      />,
    );

    rerender(
      <RecipeFeed
        {...defaultProps}
        onNearEnd={latestNearEnd}
        recipes={[baseRecipe, { ...baseRecipe, recipe_id: "recipe-2" }]}
      />,
    );
    fireEvent(getByTestId("recipe-feed-list"), "viewableItemsChanged", {
      viewableItems: [{ index: 1 }],
    });

    expect(firstNearEnd).not.toHaveBeenCalled();
    expect(latestNearEnd).toHaveBeenCalledWith(1);
  });
});
