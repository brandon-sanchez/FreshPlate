import React from "react";
import { fireEvent, render } from "@testing-library/react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PanResponder } from "react-native";
import RecipeIngredientsSheet from "@/components/recipe-ingredients-sheet";

jest.mock("@expo/vector-icons/Feather", () => () => null);
jest.mock("@expo/vector-icons/FontAwesome", () => () => null);
jest.mock("@/hooks/useReducedMotion", () => ({ useReducedMotion: () => true }));
const mockFetchRecipeImage = jest.fn();
jest.mock("@/lib/supabase", () => ({ supabase: {} }));
jest.mock("@/lib/image-api", () => ({
  fetchRecipeImage: (...args: unknown[]) => mockFetchRecipeImage(...args),
}));

const readyPhoto = {
  status: "ready",
  image_key: "recipe:photo",
  url: "https://storage.test/photo.webp?token=1",
  expires_at: new Date(Date.now() + 3_600_000).toISOString(),
  reason: null,
};

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
function queryWrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  return function QueryWrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}
const renderSheet = (
  onOpenDetail = jest.fn(),
  onClose = jest.fn(),
  onCook = jest.fn(),
) =>
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
        onCook={onCook}
      />
    </SafeAreaProvider>,
    { wrapper: queryWrapper() },
  );

describe("recipe preview sheet", () => {
  beforeEach(() => {
    mockFetchRecipeImage.mockReset();
    mockFetchRecipeImage.mockReturnValue(new Promise(() => {}));
  });

  it("shows the recipe photo above the ingredients", async () => {
    mockFetchRecipeImage.mockResolvedValue(readyPhoto);
    const screen = renderSheet();
    expect(await screen.findByLabelText("Photo of Pasta")).toBeTruthy();
    const tree = JSON.stringify(screen.toJSON());
    expect(tree.indexOf("Photo of Pasta")).toBeLessThan(
      tree.indexOf('"Tomato"'),
    );
  });

  it("renders the payload and expands from the accessible button", () => {
    const onOpen = jest.fn();
    const screen = renderSheet(onOpen);
    expect(screen.getByText("Pasta")).toBeTruthy();
    expect(screen.getByText("2 servings · 20 min")).toBeTruthy();
    expect(screen.getByText("Tomato")).toBeTruthy();
    expect(screen.getByText("1")).toBeTruthy();
    expect(screen.getByTestId("recipe-step-body-0").props.children).toBe(
      "Boil pasta",
    );
    fireEvent(screen.getByLabelText("View full recipe"), "accessibilityAction", {
      nativeEvent: { actionName: "activate" },
    });
    expect(onOpen).toHaveBeenCalledWith(recipe);
  });

  it("closes and starts cooking the previewed recipe from its primary action", () => {
    const onOpen = jest.fn();
    const onClose = jest.fn();
    const onCook = jest.fn();
    const screen = renderSheet(onOpen, onClose, onCook);
    fireEvent.press(screen.getByLabelText("Cook Pasta"));
    expect(onClose).toHaveBeenCalled();
    expect(onCook).toHaveBeenCalledWith(recipe);
    expect(onOpen).not.toHaveBeenCalled();
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
        <RecipeIngredientsSheet
          recipe={second}
          onClose={jest.fn()}
          onCook={jest.fn()}
        />
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
          onCook={jest.fn()}
        />
      </SafeAreaProvider>,
      { wrapper: queryWrapper() },
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
          onCook={jest.fn()}
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
          onCook={jest.fn()}
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
