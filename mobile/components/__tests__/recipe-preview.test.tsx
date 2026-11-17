import React from "react";
import { act, fireEvent, render } from "@testing-library/react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PanResponder } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import RecipeIngredientsSheet from "@/components/recipe-ingredients-sheet";
import { useActiveCookStore } from "@/stores/activeCook";

jest.mock("@expo/vector-icons/Feather", () => () => null);
jest.mock("@expo/vector-icons/FontAwesome", () => () => null);
jest.mock("@/hooks/useReducedMotion", () => ({ useReducedMotion: () => true }));
jest.mock("expo-crypto", () => ({
  randomUUID: () => "11111111-1111-4111-8111-111111111111",
}));
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
    { name: "Olive oil", inventory_item_id: null, use_amount: 1, unit: "tbsp" },
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

async function startCooking(target: typeof recipe) {
  await useActiveCookStore.getState().hydrate("u1", "h1");
  await useActiveCookStore.getState().start("u1", "h1", target);
}

describe("recipe preview sheet", () => {
  beforeEach(async () => {
    mockFetchRecipeImage.mockReset();
    mockFetchRecipeImage.mockReturnValue(new Promise(() => {}));
    await AsyncStorage.clear();
  });

  afterEach(() => act(() => useActiveCookStore.getState().leaveScope()));

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
    expect(screen.getByTestId("recipe-stats")).toHaveTextContent(
      "20 minTime2Serves",
    );
    expect(screen.getByText("Tomato")).toBeTruthy();
    expect(screen.getAllByText("2")).not.toHaveLength(0);
    expect(screen.queryByText("2 each")).toBeNull();
    expect(screen.getByText("1")).toBeTruthy();
    expect(screen.getByTestId("recipe-step-body-0").props.children).toBe(
      "Boil pasta",
    );
    fireEvent(screen.getByLabelText("View full recipe"), "accessibilityAction", {
      nativeEvent: { actionName: "activate" },
    });
    expect(onOpen).toHaveBeenCalledWith(recipe);
  });

  it("marks an ingredient with no food as a kitchen basic", () => {
    const screen = renderSheet();
    expect(screen.getByText("Olive oil")).toBeTruthy();
    expect(screen.getAllByText("Kitchen basic")).toHaveLength(1);
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

  it("offers to continue the active cook instead of starting it again", async () => {
    await startCooking(recipe);
    const onClose = jest.fn();
    const onCook = jest.fn();
    const screen = renderSheet(jest.fn(), onClose, onCook);

    expect(screen.queryByText("Cook this")).toBeNull();
    fireEvent.press(screen.getByLabelText("Continue cooking Pasta"));

    expect(onClose).toHaveBeenCalled();
    expect(onCook).toHaveBeenCalledWith(recipe);
  });

  it("still offers to cook another recipe while a different cook is active", async () => {
    await startCooking({ ...recipe, recipe_id: "r2", title: "Soup" });
    const onCook = jest.fn();
    const screen = renderSheet(jest.fn(), jest.fn(), onCook);

    expect(screen.getByText("Cook this")).toBeTruthy();
    fireEvent.press(screen.getByLabelText("Cook Pasta"));

    expect(onCook).toHaveBeenCalledWith(recipe);
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
