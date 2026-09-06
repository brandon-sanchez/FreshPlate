import React from "react";
import { Dimensions } from "react-native";
import { act, fireEvent, render } from "@testing-library/react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import RecipeDetail from "@/components/recipe-detail";
import type { RecipeSuggestion } from "@/types/recipes";

jest.mock("@expo/vector-icons/Feather", () => () => null);
jest.mock("@expo/vector-icons/FontAwesome", () => () => null);
jest.mock("@/hooks/useReducedMotion", () => ({ useReducedMotion: () => true }));

const recipe: RecipeSuggestion = {
  recipe_id: "10000000-0000-4000-8000-000000000001",
  title: "Spinach skillet",
  cook_time_minutes: 20,
  servings: 2,
  match_percent: 80,
  ingredients: [
    {
      name: "Spinach",
      inventory_item_id: "spinach",
      use_amount: 100,
      unit: "g",
    },
    { name: "Garlic", inventory_item_id: null, use_amount: 2, unit: "cloves" },
  ],
  steps: ["Rinse the spinach.", "Sauté and serve."],
  saves_expiring: ["Spinach"],
};
const wrapper = ({ children }: { children: React.ReactNode }) => (
  <SafeAreaProvider
    initialMetrics={{
      frame: { x: 0, y: 0, width: 390, height: 844 },
      insets: { top: 44, right: 0, bottom: 34, left: 0 },
    }}
  >
    {children}
  </SafeAreaProvider>
);

it("renders the selected snapshot and sends its identity to the shared save action", () => {
  const onToggleSave = jest.fn();
  const onClose = jest.fn();
  const screen = render(
    <RecipeDetail
      recipe={recipe}
      isSaved={false}
      isSavePending={false}
      onToggleSave={onToggleSave}
      onClose={onClose}
    />,
    { wrapper },
  );
  expect(screen.getByText("Spinach skillet")).toBeTruthy();
  expect(screen.getByText("Need 100 g")).toBeTruthy();
  expect(screen.getByText("In fridge")).toBeTruthy();
  expect(screen.getByText("Buy")).toBeTruthy();
  expect(screen.getByText("Sauté and serve.")).toBeTruthy();
  expect(screen.queryByText(recipe.recipe_id)).toBeNull();
  fireEvent.press(screen.getByLabelText("Save recipe"));
  expect(onToggleSave).toHaveBeenCalledWith(recipe, false);
  fireEvent.press(screen.getByLabelText("Close recipe details"));
  expect(onClose).toHaveBeenCalledTimes(1);
});

it("uses updated saved state and blocks a second toggle while saving", () => {
  const onToggleSave = jest.fn();
  const props = { recipe, onToggleSave, onClose: jest.fn(), isSaved: true };
  const screen = render(<RecipeDetail {...props} isSavePending />, { wrapper });
  fireEvent.press(screen.getByLabelText("Remove recipe from saved recipes"));
  expect(onToggleSave).not.toHaveBeenCalled();
  screen.rerender(<RecipeDetail {...props} isSavePending={false} />);
  fireEvent.press(screen.getByLabelText("Remove recipe from saved recipes"));
  expect(onToggleSave).toHaveBeenCalledWith(recipe, true);
});

it("gives long ingredients the full row when text is enlarged", () => {
  const original = Dimensions.get("window");
  const dimensions = { width: 390, height: 844, scale: 3, fontScale: 1 };
  Dimensions.set({ window: dimensions, screen: dimensions });
  const selected = {
    ...recipe,
    ingredients: [
      { ...recipe.ingredients[0], name: "Chickpeas, drained and rinsed" },
      recipe.ingredients[1],
    ],
  };
  const screen = render(
    <RecipeDetail
      recipe={selected}
      isSaved={false}
      isSavePending={false}
      onToggleSave={jest.fn()}
      onClose={jest.fn()}
    />,
    { wrapper },
  );
  expect(screen.getByTestId("recipe-detail-ingredient-0")).toHaveStyle({
    width: "50%",
  });
  act(() =>
    Dimensions.set({
      window: { ...dimensions, fontScale: 2 },
      screen: dimensions,
    }),
  );
  expect(screen.getByTestId("recipe-detail-ingredient-0")).toHaveStyle({
    width: "100%",
  });
  expect(screen.getByText("Chickpeas, drained and rinsed")).toBeTruthy();
  screen.unmount();
  Dimensions.set({ window: original, screen: original });
});
