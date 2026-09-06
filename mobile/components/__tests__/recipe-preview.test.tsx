import React from "react";
import { fireEvent, render } from "@testing-library/react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { PanResponder } from "react-native";
import RecipeIngredientsSheet from "@/components/recipe-ingredients-sheet";

jest.mock("@expo/vector-icons/Feather", () => () => null);
jest.mock("@/hooks/useReducedMotion", () => ({ useReducedMotion: () => true }));

const recipe = {
  recipe_id: "r1",
  title: "Pasta",
  cook_time_minutes: 20,
  servings: 2,
  match_percent: 90,
  saves_expiring: [],
  ingredients: [
    { name: "Tomato", inventory_item_id: "t1", use_amount: 2, unit: "each" },
  ],
  steps: ["Boil pasta", "Add tomato"],
};
const renderSheet = (onOpenDetail = jest.fn(), onClose = jest.fn()) =>
  render(
    <SafeAreaProvider
      initialMetrics={{
        frame: { x: 0, y: 0, width: 390, height: 844 },
        insets: { top: 44, right: 0, bottom: 34, left: 0 },
      }}
    >
      <RecipeIngredientsSheet
        recipe={recipe}
        onClose={onClose}
        onOpenDetail={onOpenDetail}
      />
    </SafeAreaProvider>,
  );

describe("recipe preview sheet", () => {
  it("renders the payload and expands from the accessible button", () => {
    const onOpen = jest.fn();
    const screen = renderSheet(onOpen);
    expect(screen.getByText("Pasta")).toBeTruthy();
    expect(screen.getByText(/2 servings/)).toBeTruthy();
    expect(screen.getByText("Tomato")).toBeTruthy();
    expect(screen.getByText("1")).toBeTruthy();
    expect(screen.getByTestId("recipe-step-body-0").props.children).toBe(
      "Boil pasta",
    );
    fireEvent.press(screen.getByLabelText("View full recipe"));
    expect(onOpen).toHaveBeenCalledWith(recipe);
  });

  it("closes without changing the payload", () => {
    const onOpen = jest.fn();
    const onClose = jest.fn();
    const screen = renderSheet(onOpen, onClose);
    fireEvent.press(screen.getByTestId("recipe-ingredients-close"));
    expect(onClose).toHaveBeenCalled();
  });

  it("updates the preview payload when the selected recipe changes", () => {
    const screen = renderSheet();
    const second = {
      ...recipe,
      recipe_id: "r2",
      title: "Rice",
      steps: ["Steam rice"],
    };
    screen.rerender(
      <SafeAreaProvider
        initialMetrics={{
          frame: { x: 0, y: 0, width: 390, height: 844 },
          insets: { top: 44, right: 0, bottom: 34, left: 0 },
        }}
      >
        <RecipeIngredientsSheet recipe={second} onClose={jest.fn()} />
      </SafeAreaProvider>,
    );
    expect(screen.getByText("Rice")).toBeTruthy();
    expect(screen.getByText("1")).toBeTruthy();
    expect(screen.getByTestId("recipe-step-body-0").props.children).toBe(
      "Steam rice",
    );
  });

  it("expands the current recipe after opening from a closed sheet and switching recipes", () => {
    const createSpy = jest.spyOn(PanResponder, "create");
    const first = { ...recipe, title: "First" };
    const second = { ...recipe, recipe_id: "r2", title: "Second" };
    const onOpen = jest.fn();
    const view = render(
      <SafeAreaProvider
        initialMetrics={{
          frame: { x: 0, y: 0, width: 390, height: 844 },
          insets: { top: 44, right: 0, bottom: 34, left: 0 },
        }}
      >
        <RecipeIngredientsSheet
          recipe={null}
          onClose={jest.fn()}
          onOpenDetail={onOpen}
        />
      </SafeAreaProvider>,
    );
    const handlers = createSpy.mock.calls[createSpy.mock.calls.length - 1][0];
    view.rerender(
      <SafeAreaProvider
        initialMetrics={{
          frame: { x: 0, y: 0, width: 390, height: 844 },
          insets: { top: 44, right: 0, bottom: 34, left: 0 },
        }}
      >
        <RecipeIngredientsSheet
          recipe={first}
          onClose={jest.fn()}
          onOpenDetail={onOpen}
        />
      </SafeAreaProvider>,
    );
    handlers.onPanResponderGrant?.(
      { nativeEvent: { pageY: 600 } } as never,
      {} as never,
    );
    handlers.onPanResponderRelease?.(
      { nativeEvent: { pageY: 400 } } as never,
      {} as never,
    );
    expect(onOpen).toHaveBeenLastCalledWith(first);
    view.rerender(
      <SafeAreaProvider
        initialMetrics={{
          frame: { x: 0, y: 0, width: 390, height: 844 },
          insets: { top: 44, right: 0, bottom: 34, left: 0 },
        }}
      >
        <RecipeIngredientsSheet
          recipe={second}
          onClose={jest.fn()}
          onOpenDetail={onOpen}
        />
      </SafeAreaProvider>,
    );
    handlers.onPanResponderGrant?.(
      { nativeEvent: { pageY: 600 } } as never,
      {} as never,
    );
    handlers.onPanResponderRelease?.(
      { nativeEvent: { pageY: 400 } } as never,
      {} as never,
    );
    expect(onOpen).toHaveBeenLastCalledWith(second);
    createSpy.mockRestore();
  });
});
