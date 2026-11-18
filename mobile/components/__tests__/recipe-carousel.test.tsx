import React from "react";
import { Pressable, Text } from "react-native";
import { act, fireEvent, render, within } from "@testing-library/react-native";
import { State } from "react-native-gesture-handler";
import {
  fireGestureHandler,
  getByGestureTestId,
} from "react-native-gesture-handler/jest-utils";
import { getAnimatedStyle } from "react-native-reanimated";
import RecipeCarousel, {
  type RecipeCarouselItem,
} from "@/components/recipe-carousel";

jest.mock("@expo/vector-icons/Feather", () => () => null);
jest.mock("@/hooks/useReducedMotion", () => ({ useReducedMotion: () => true }));

function recipe(id: string): RecipeCarouselItem {
  return {
    id,
    kind: "recipe",
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
  describe("with a trailing slot", () => {
    const message: RecipeCarouselItem = {
      id: "tail",
      kind: "message",
      content: <Text>{"That's all for now"}</Text>,
    };
    const loading: RecipeCarouselItem = {
      id: "tail",
      kind: "loading",
      content: <Text>Finding more recipes</Text>,
    };
    const stageHeight = 510;

    beforeEach(() => jest.useFakeTimers());
    afterEach(() => {
      jest.runOnlyPendingTimers();
      jest.useRealTimers();
    });

    function firstCardBottomAfterNext(tail: RecipeCarouselItem) {
      const { getByRole, getByTestId } = render(
        <RecipeCarousel {...props} items={[recipe("1"), tail]} />,
      );
      fireEvent(getByTestId("recipe-carousel-stage"), "layout", {
        nativeEvent: {
          layout: { x: 0, y: 0, width: 390, height: stageHeight },
        },
      });
      fireEvent.press(getByRole("button", { name: "Next recipe" }));
      act(() => jest.advanceTimersByTime(500));
      const slot = getByTestId("recipe-carousel-slot-0", {
        includeHiddenElements: true,
      });
      const [translate] = getAnimatedStyle(slot).transform as {
        translateY: number;
      }[];
      const slotTop = (stageHeight - props.cardHeight) / 2;
      return slotTop + translate.translateY + props.cardHeight;
    }

    it("moves the last recipe fully above the stage once the message is centered", () => {
      expect(firstCardBottomAfterNext(message)).toBeLessThan(0);
    });

    it("keeps the last recipe stacked behind a loading card", () => {
      expect(firstCardBottomAfterNext(loading)).toBeGreaterThan(0);
    });

    it("hides the message behind the last card and shows it once centered", () => {
      const behind = render(
        <RecipeCarousel {...props} items={[recipe("1"), message]} />,
      );
      expect(
        behind.getByTestId("recipe-carousel-slot-1", {
          includeHiddenElements: true,
        }),
      ).toHaveStyle({ opacity: 0 });
      behind.unmount();
      const alone = render(<RecipeCarousel {...props} items={[message]} />);
      expect(alone.getByTestId("recipe-carousel-slot-0")).toHaveStyle({
        opacity: 1,
      });
    });
  });

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
      kind: "loading",
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

  function swipe(translationY: number, velocityY: number) {
    return act(async () =>
      fireGestureHandler(getByGestureTestId("recipe-carousel-pan"), [
        { state: State.BEGAN, translationY: 0, velocityY: 0 },
        { state: State.ACTIVE, translationY: 0, velocityY: 0 },
        { state: State.ACTIVE, translationY, velocityY },
        { state: State.END, translationY, velocityY },
      ]),
    );
  }

  it.each([
    ["a gentle swipe", -140, -1500, false],
    ["a fast fling", -900, -3000, false],
    ["a fast fling with reduced motion", -900, -3000, true],
  ])(
    "moves exactly one recipe for %s",
    async (_name, translationY, velocityY, reducedMotion) => {
      const onActiveIndexChange = jest.fn();
      const { getByRole } = render(
        <RecipeCarousel
          {...props}
          items={recipes}
          reducedMotion={reducedMotion}
          onActiveIndexChange={onActiveIndexChange}
        />,
      );
      await swipe(translationY, velocityY);
      expect(getByRole("button", { name: "Ingredients 2" })).toBeTruthy();
      expect(onActiveIndexChange).toHaveBeenLastCalledWith(1);
    },
  );

  it("moves back exactly one recipe for a downward fling", async () => {
    const onActiveIndexChange = jest.fn();
    const { getByRole } = render(
      <RecipeCarousel
        {...props}
        items={recipes}
        onActiveIndexChange={onActiveIndexChange}
      />,
    );
    fireEvent.press(getByRole("button", { name: "Next recipe" }));
    fireEvent.press(getByRole("button", { name: "Next recipe" }));
    fireEvent.press(getByRole("button", { name: "Next recipe" }));
    await swipe(900, 3000);
    expect(getByRole("button", { name: "Ingredients 3" })).toBeTruthy();
    expect(onActiveIndexChange).toHaveBeenLastCalledWith(2);
  });

  it("stays on the recipe after a small accidental drag", async () => {
    const onActiveIndexChange = jest.fn();
    const { getByRole } = render(
      <RecipeCarousel
        {...props}
        items={recipes}
        onActiveIndexChange={onActiveIndexChange}
      />,
    );
    await swipe(-20, -50);
    expect(getByRole("button", { name: "Ingredients 1" })).toBeTruthy();
    expect(onActiveIndexChange).toHaveBeenLastCalledWith(0);
  });

  it("plays a sweep exit on the leaving slot only, dimming included", () => {
    const items = recipes.slice(0, 3).map((item, index) =>
      index === 1 ? { ...item, exitDelayMs: 0 } : item,
    );
    const screen = render(<RecipeCarousel {...props} items={items} />);

    const [leaving] = screen.getAllByTestId("recipe-sweep-leaving", {
      includeHiddenElements: true,
    });
    const slot = screen.getByTestId("recipe-carousel-slot-1", {
      includeHiddenElements: true,
    });
    expect(
      within(slot).getAllByTestId("recipe-sweep-leaving", {
        includeHiddenElements: true,
      }),
    ).toEqual([leaving]);
    expect(within(leaving).getByText("2", { includeHiddenElements: true })).toBeTruthy();
    expect(
      within(screen.getByTestId("recipe-carousel-slot-0")).queryAllByTestId(
        "recipe-sweep-leaving",
        { includeHiddenElements: true },
      ),
    ).toHaveLength(0);
  });
});
