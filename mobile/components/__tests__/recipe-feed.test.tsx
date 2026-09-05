import React from "react";
import { act, cleanup, fireEvent, render } from "@testing-library/react-native";
import type { RecipeSuggestion } from "@/types/recipes";

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

const baseRecipe: RecipeSuggestion = {
  recipe_id: "recipe-1",
  title: "Spinach Pasta",
  cook_time_minutes: 24,
  servings: 2,
  ingredients: [],
  steps: ["Cook it"],
  match_percent: 92,
  saves_expiring: ["Baby Spinach"],
};

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
  onNearEnd: jest.fn(),
  onRetryMore: jest.fn(),
  onAddItems: jest.fn(),
  onEditAnswers: jest.fn(),
};

describe("RecipeFeed", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockReducedMotion.mockReturnValue(false);
  });

  afterEach(() => {
    cleanup();
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it("does not count offscreen cards as consumed when the list nears its end", () => {
    const onNearEnd = jest.fn();
    const { getByTestId } = render(
      <RecipeFeed {...defaultProps} onNearEnd={onNearEnd}
        recipes={Array.from({ length: 5 }, (_, index) => ({ ...baseRecipe, recipe_id: `${index}` }))} />,
    );
    fireEvent(getByTestId("recipe-feed-list"), "viewableItemsChanged", {
      viewableItems: [{ index: 0 }, { index: 1 }],
    });
    fireEvent(getByTestId("recipe-feed-list"), "endReached");
    expect(onNearEnd).toHaveBeenLastCalledWith(1);
  });

  it("starts an unseen card in its entry pose rather than flashing it fully visible", () => {
    const { getByTestId } = render(<RecipeFeed {...defaultProps} recipes={[baseRecipe]} />);
    expect(getByTestId("recipe-card-recipe-1")).toHaveStyle({ opacity: 0.45 });
  });

  it("dismisses immediately with reduced motion enabled", () => {
    mockReducedMotion.mockReturnValue(true);
    const onDismiss = jest.fn();
    const { getByTestId } = render(
      <RecipeFeed {...defaultProps} onDismiss={onDismiss} recipes={[baseRecipe]} />,
    );
    fireEvent.press(getByTestId("recipe-card-not-this-recipe-1"));
    expect(onDismiss).toHaveBeenCalledWith("recipe-1");
  });
  it("shows an honest loading tail while existing recipes stay scrollable", () => {
    const { getByTestId, getByText, queryByText } = render(
      <RecipeFeed {...defaultProps} isPrefetching recipes={[baseRecipe]} />,
    );
    expect(getByTestId("recipe-feed-loading")).toBeTruthy();
    expect(getByText("Spinach Pasta")).toBeTruthy();
    expect(queryByText("That's all for now")).toBeNull();
  });
  it("renders the generated card contract", () => {
    const { getByText } = render(
      <RecipeFeed {...defaultProps} recipes={[baseRecipe]} />,
    );

    expect(getByText("Generated")).toBeTruthy();
    expect(getByText("Spinach Pasta")).toBeTruthy();
    expect(getByText("24 min")).toBeTruthy();
    expect(getByText("92% match")).toBeTruthy();
    expect(getByText("Saves Baby Spinach")).toBeTruthy();
  });

  it("mounts the full startup batch for a staged reveal", () => {
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
    expect(list.props.initialNumToRender).toBe(8);
    expect(list.props.maxToRenderPerBatch).toBe(8);
  });

  it("keeps a background refill issue secondary to visible cards", () => {
    const { getByText } = render(
      <RecipeFeed
        {...defaultProps}
        recipes={[baseRecipe]}
        prefetchError={new Error("AI unavailable")}
      />,
    );

    expect(getByText("We couldn't load more recipes right now.")).toBeTruthy();
  });

  it("dismisses a card after the slide-up animation", () => {
    const onDismiss = jest.fn();
    const { getByTestId } = render(
      <RecipeFeed
        {...defaultProps}
        onDismiss={onDismiss}
        recipes={[baseRecipe]}
      />,
    );

    fireEvent.press(getByTestId("recipe-card-not-this-recipe-1"));
    act(() => jest.advanceTimersByTime(220));

    expect(onDismiss).toHaveBeenCalledWith("recipe-1");
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
