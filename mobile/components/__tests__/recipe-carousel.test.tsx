import React from "react";
import { Pressable, Text } from "react-native";
import { act, fireEvent, render } from "@testing-library/react-native";
import { State } from "react-native-gesture-handler";
import {
  fireGestureHandler,
  getByGestureTestId,
} from "react-native-gesture-handler/jest-utils";
import RecipeCarousel, {
  type RecipeCarouselItem,
} from "@/components/recipe-carousel";

jest.mock("@expo/vector-icons/Feather", () => () => null);
jest.mock("@/hooks/useReducedMotion", () => ({ useReducedMotion: () => true }));

function recipe(id: string): RecipeCarouselItem {
  return {
    id,
    isRecipe: true,
    content: (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Ingredients ${id}`}
      >
        <Text>{id}</Text>
      </Pressable>
    ),
  };
}

const recipes = Array.from({ length: 8 }, (_, index) =>
  recipe(String(index + 1)),
);
const props = {
  cardHeight: 430,
  reducedMotion: true,
  onActiveIndexChange: jest.fn(),
};

describe("RecipeCarousel", () => {
  it("exposes only the centered recipe to accessibility and reports only that recipe as viewed", () => {
    const onActiveIndexChange = jest.fn();
    const { getByRole, queryByRole } = render(
      <RecipeCarousel
        {...props}
        items={recipes}
        onActiveIndexChange={onActiveIndexChange}
      />,
    );
    expect(getByRole("button", { name: "Ingredients 1" })).toBeTruthy();
    expect(queryByRole("button", { name: "Ingredients 2" })).toBeNull();
    expect(getByRole("button", { name: "Previous recipe" })).toBeDisabled();
    expect(onActiveIndexChange).toHaveBeenLastCalledWith(0);

    fireEvent.press(getByRole("button", { name: "Next recipe" }));
    expect(queryByRole("button", { name: "Ingredients 1" })).toBeNull();
    expect(getByRole("button", { name: "Ingredients 2" })).toBeTruthy();
    expect(onActiveIndexChange).toHaveBeenLastCalledWith(1);
  });

  it("keeps the successor centered when the active recipe is dismissed", () => {
    const onActiveIndexChange = jest.fn();
    const { getByRole, rerender } = render(
      <RecipeCarousel
        {...props}
        items={recipes}
        onActiveIndexChange={onActiveIndexChange}
      />,
    );
    fireEvent.press(getByRole("button", { name: "Next recipe" }));
    rerender(
      <RecipeCarousel
        {...props}
        items={recipes.filter((item) => item.id !== "2")}
        onActiveIndexChange={onActiveIndexChange}
      />,
    );
    expect(getByRole("button", { name: "Ingredients 3" })).toBeTruthy();
    expect(onActiveIndexChange).toHaveBeenLastCalledWith(1);
  });

  it("replaces a reached loading tail with the first new recipe without resetting position", () => {
    const tail: RecipeCarouselItem = {
      id: "tail",
      isRecipe: false,
      content: <Text>Finding more recipes</Text>,
    };
    const { getByRole, getByText, queryByText, rerender } = render(
      <RecipeCarousel {...props} items={[recipes[0], tail]} />,
    );
    fireEvent.press(getByRole("button", { name: "Next recipe" }));
    expect(getByText("Finding more recipes")).toBeTruthy();
    expect(getByRole("button", { name: "Next recipe" })).toBeDisabled();
    rerender(<RecipeCarousel {...props} items={[...recipes, tail]} />);
    expect(getByRole("button", { name: "Ingredients 2" })).toBeTruthy();
    expect(queryByText("Finding more recipes")).toBeNull();
    expect(getByRole("button", { name: "Next recipe" })).not.toBeDisabled();
  });

  it("stops at the end and clamps the active position when the last recipe is removed", () => {
    const { getByRole, rerender } = render(
      <RecipeCarousel {...props} items={recipes.slice(0, 2)} />,
    );
    fireEvent.press(getByRole("button", { name: "Next recipe" }));
    expect(getByRole("button", { name: "Next recipe" })).toBeDisabled();
    rerender(<RecipeCarousel {...props} items={recipes.slice(0, 1)} />);
    expect(getByRole("button", { name: "Ingredients 1" })).toBeTruthy();
    expect(getByRole("button", { name: "Previous recipe" })).toBeDisabled();
  });

  it.each([false, true])(
    "bounds a fast fling to two recipes with reduced motion %s",
    async (reducedMotion) => {
      const onActiveIndexChange = jest.fn();
      const { getByRole } = render(
        <RecipeCarousel
          {...props}
          items={recipes}
          reducedMotion={reducedMotion}
          onActiveIndexChange={onActiveIndexChange}
        />,
      );
      await act(async () =>
        fireGestureHandler(getByGestureTestId("recipe-carousel-pan"), [
          { state: State.BEGAN, translationY: 0, velocityY: 0 },
          { state: State.ACTIVE, translationY: 0, velocityY: 0 },
          { state: State.ACTIVE, translationY: -900, velocityY: -3000 },
          { state: State.END, translationY: -900, velocityY: -3000 },
        ]),
      );
      expect(getByRole("button", { name: "Ingredients 3" })).toBeTruthy();
      expect(onActiveIndexChange).toHaveBeenLastCalledWith(2);
    },
  );
});
