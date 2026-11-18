import React from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useActiveCookStore } from "@/stores/activeCook";
import { useAuthStore } from "@/stores/auth";
import type { CookPlan } from "@/types/cook";

const mockApiFetch = jest.fn();
const mockRouter = { back: jest.fn(), replace: jest.fn(), dismissTo: jest.fn(), canGoBack: () => true };
const mockSavedRows = jest.fn();
const mockInsert = jest.fn();

function mockTable(table: string) {
  const rows = () =>
    table === "saved_recipes" ? mockSavedRows() : { data: [], error: null };
  const query = {
    select: () => query,
    eq: () => query,
    gt: () => query,
    order: async () => rows(),
    insert: async (row: unknown) => mockInsert(table, row),
  };
  return query;
}

jest.mock("@expo/vector-icons/Feather", () => () => null);
jest.mock("@expo/vector-icons/FontAwesome", () => () => null);
jest.mock("@/hooks/useReducedMotion", () => ({ useReducedMotion: () => true }));
jest.mock("expo-router", () => ({
  useRouter: () => mockRouter,
  useLocalSearchParams: () => ({ stage: "checklist" }),
}));
jest.mock("@/lib/supabase", () => ({
  supabase: { from: (table: string) => mockTable(table) },
}));
jest.mock("@/lib/image-api", () => ({
  fetchFoodImage: () => new Promise(() => undefined),
}));
jest.mock("expo-crypto", () => ({
  randomUUID: () => "11111111-1111-4111-8111-111111111111",
}));
jest.mock("@/lib/api", () => ({
  ...jest.requireActual("@/lib/api"),
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}));

import CookScreen from "@/app/cook";

const AUTO_RETURN_WAIT_MS = 2000;

const recipe = {
  recipe_id: "r1",
  title: "Shakshuka",
  cook_time_minutes: 20,
  servings: 2,
  match_percent: 90,
  ingredients: [{ name: "Eggs", inventory_item_id: "eggs", use_amount: 3, unit: "egg" }],
  steps: ["Cook"],
  saves_expiring: [],
};

const plan: CookPlan = {
  foods: [
    {
      food_id: "eggs",
      name: "Eggs",
      stock_base: "each",
      each_label: "egg",
      whole_units_only: true,
      available: 6,
      draw: 3,
      estimated: false,
      rounding_note: null,
      lines: [
        { line: 0, ingredient: "Eggs", recipe_amount: 3, recipe_unit: "egg", mode: "draw", stock_amount: 3 },
      ],
    },
  ],
  untracked: [],
};

function savedRow() {
  return {
    id: "saved-1",
    household_id: "h1",
    recipe_id: "r1",
    recipe,
    saved_by: "u1",
    created_at: "2026-11-17T10:00:00+00:00",
  };
}

function renderCookScreen() {
  mockApiFetch.mockImplementation(async (path: string) =>
    path === "/api/cook/plan" ? { data: plan } : { data: {} },
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  return render(
    <SafeAreaProvider
      initialMetrics={{
        frame: { x: 0, y: 0, width: 390, height: 844 },
        insets: { top: 47, left: 0, right: 0, bottom: 34 },
      }}
    >
      <QueryClientProvider client={client}>
        <CookScreen />
      </QueryClientProvider>
    </SafeAreaProvider>,
  );
}

async function confirmCook() {
  await screen.findByText("Eggs");
  await act(async () => {
    fireEvent.press(screen.getByTestId("cook-confirm"));
  });
  await screen.findByText("Nice plate");
}

beforeEach(async () => {
  jest.clearAllMocks();
  mockSavedRows.mockReturnValue({ data: [], error: null });
  mockInsert.mockImplementation(() => {
    mockSavedRows.mockReturnValue({ data: [savedRow()], error: null });
    return { error: null };
  });
  await AsyncStorage.clear();
  useAuthStore.setState({ user: { id: "u1" } as never, householdId: "h1" });
  await useActiveCookStore.getState().hydrate("u1", "h1");
  await useActiveCookStore.getState().start("u1", "h1", recipe as never);
});

afterEach(() => useActiveCookStore.getState().leaveScope());

it("shows the success screen after confirming, ends the cook and waits for a choice", async () => {
  renderCookScreen();

  await confirmCook();

  expect(screen.getByText("Your fridge is updated.")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Save this recipe" })).toBeTruthy();
  expect(useActiveCookStore.getState().activeCook).toBeNull();
  await act(() => new Promise((resolve) => setTimeout(resolve, AUTO_RETURN_WAIT_MS)));
  expect(mockRouter.dismissTo).not.toHaveBeenCalled();
  expect(mockRouter.back).not.toHaveBeenCalled();

  fireEvent.press(screen.getByRole("button", { name: "Done" }));

  expect(mockRouter.dismissTo).toHaveBeenCalledWith("/(tabs)/inventory");
});

it("saves the cooked recipe with its id, then returns to the inventory", async () => {
  renderCookScreen();
  await confirmCook();

  await act(async () => {
    fireEvent.press(screen.getByRole("button", { name: "Save this recipe" }));
  });

  expect(mockInsert).toHaveBeenCalledWith("saved_recipes", {
    household_id: "h1",
    recipe_id: "r1",
    recipe,
    saved_by: "u1",
  });
  expect(await screen.findByText("Saved to your recipes")).toBeTruthy();
  await waitFor(() => expect(mockRouter.dismissTo).toHaveBeenCalledWith("/(tabs)/inventory"), {
    timeout: AUTO_RETURN_WAIT_MS,
  });
});

it("returns to the inventory by itself when the recipe was already saved", async () => {
  mockSavedRows.mockReturnValue({ data: [savedRow()], error: null });
  renderCookScreen();
  await confirmCook();

  expect(screen.getByText("Saved to your recipes")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Save this recipe" })).toBeNull();
  await waitFor(() => expect(mockRouter.dismissTo).toHaveBeenCalledWith("/(tabs)/inventory"), {
    timeout: AUTO_RETURN_WAIT_MS,
  });
  expect(mockInsert).not.toHaveBeenCalled();
});
