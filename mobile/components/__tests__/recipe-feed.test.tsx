import React from "react";
import { act, fireEvent, render } from "@testing-library/react-native";
import type { RecipeSuggestion } from "@/types/recipes";

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
    jest.useFakeTimers();
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
    jest.useRealTimers();
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
