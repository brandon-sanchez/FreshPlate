import React from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ApiError } from "@/lib/api";
import { useActiveCookStore } from "@/stores/activeCook";
import { useAuthStore } from "@/stores/auth";
import type { CookPlan } from "@/types/cook";

const mockApiFetch = jest.fn();
const mockFoodStock = [
  {
    id: "rice",
    name: "Basmati rice",
    stock_base: "g",
    each_label: null,
    whole_units_only: false,
    available: 400,
  },
];
const mockStockQuery = {
  select: () => mockStockQuery,
  eq: () => mockStockQuery,
  gt: () => mockStockQuery,
  order: async () => ({ data: mockFoodStock, error: null }),
};

jest.mock("@expo/vector-icons/Feather", () => () => null);
jest.mock("@expo/vector-icons/FontAwesome", () => () => null);
jest.mock("@/hooks/useReducedMotion", () => ({ useReducedMotion: () => true }));
jest.mock("@/lib/supabase", () => ({
  supabase: { from: () => mockStockQuery },
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

import CookChecklist from "@/components/cook-checklist";

const recipe = {
  recipe_id: "r1",
  title: "Shakshuka",
  cook_time_minutes: 20,
  servings: 2,
  match_percent: 90,
  ingredients: [
    { name: "Eggs", inventory_item_id: "eggs", use_amount: 3, unit: "egg" },
    { name: "Salt", inventory_item_id: null, use_amount: 1, unit: "pinch" },
  ],
  steps: ["Cook"],
  saves_expiring: [],
};

const planWith = (available: number): CookPlan => ({
  foods: [
    {
      food_id: "eggs",
      name: "Eggs",
      stock_base: "each",
      each_label: "egg",
      whole_units_only: true,
      available,
      draw: 3,
      estimated: false,
      rounding_note: null,
      lines: [
        { line: 0, ingredient: "Eggs", recipe_amount: 3, recipe_unit: "egg", mode: "draw", stock_amount: 3 },
      ],
    },
  ],
  untracked: [{ line: 1, name: "Salt", reason: "basic" }],
});

function renderChecklist(plans: CookPlan[], confirm: () => unknown) {
  mockApiFetch.mockImplementation(async (path: string) =>
    path === "/api/cook/plan" ? { data: plans.shift() } : confirm(),
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <SafeAreaProvider
      initialMetrics={{
        frame: { x: 0, y: 0, width: 390, height: 844 },
        insets: { top: 47, left: 0, right: 0, bottom: 34 },
      }}
    >
      <QueryClientProvider client={client}>
        <CookChecklist onBack={jest.fn()} onConfirmed={jest.fn()} />
      </QueryClientProvider>
    </SafeAreaProvider>,
  );
}

async function waitForConfirmToSettle() {
  await waitFor(() =>
    expect(screen.getByTestId("cook-confirm").props.accessibilityState).toMatchObject({
      disabled: false,
    }),
  );
}

beforeEach(async () => {
  jest.clearAllMocks();
  await AsyncStorage.clear();
  useAuthStore.setState({ user: { id: "u1" } as never, householdId: "h1" });
  await useActiveCookStore.getState().hydrate("u1", "h1");
  await useActiveCookStore.getState().start("u1", "h1", recipe as never);
});

afterEach(() => useActiveCookStore.getState().leaveScope());

it("shows each tracked food's stock before and after, and greys untracked staples", async () => {
  renderChecklist([planWith(6)], () => ({}));

  expect(await screen.findByText("You have 6 eggs → after: 3 eggs")).toBeTruthy();
  expect(screen.getByText("Shakshuka")).toBeTruthy();
  expect(screen.getByText("Not tracked - no deduction")).toBeTruthy();

  fireEvent.press(screen.getByLabelText("Use less Eggs"));
  expect(screen.getByText("You have 6 eggs → after: 4 eggs")).toBeTruthy();
});

it("adds a household food from the type-ahead", async () => {
  renderChecklist([planWith(6)], () => ({}));
  await screen.findByText("Eggs");
  await act(async () => undefined);

  fireEvent.changeText(screen.getByTestId("cook-add-item"), "rice");
  fireEvent.press(screen.getByLabelText("Add Basmati rice"));

  expect(screen.getByText("You have 400 g → after: 395 g")).toBeTruthy();
  expect(screen.queryByLabelText("Add Basmati rice")).toBeNull();
});

it("marks the lines that changed when another cook took the stock first", async () => {
  renderChecklist([planWith(6), planWith(2)], () => {
    throw new ApiError(409, "Some ingredients changed", "STOCK_CHANGED");
  });
  await screen.findByText("Eggs");
  await waitForConfirmToSettle();

  await act(async () => {
    fireEvent.press(screen.getByTestId("cook-confirm"));
  });

  await waitFor(() => expect(screen.getByText("Only 2 eggs left now")).toBeTruthy());
  expect(screen.getByRole("alert")).toBeTruthy();
  expect(useActiveCookStore.getState().activeCook).not.toBeNull();
});

it("ignores a confirm tapped while the checklist is still settling", async () => {
  const confirm = jest.fn(() => ({}));
  renderChecklist([planWith(6)], confirm);
  await screen.findByText("Eggs");

  fireEvent.press(screen.getByTestId("cook-confirm"));
  expect(confirm).not.toHaveBeenCalled();

  await waitForConfirmToSettle();
  await act(async () => {
    fireEvent.press(screen.getByTestId("cook-confirm"));
  });
  expect(confirm).toHaveBeenCalledTimes(1);
});

it("warns on the line when the amount used is more than the stock", async () => {
  renderChecklist([planWith(2)], () => ({}));

  expect(await screen.findByText("More than the 2 eggs you have")).toBeTruthy();

  fireEvent.press(screen.getByLabelText("Use less Eggs"));
  expect(screen.queryByText("More than the 2 eggs you have")).toBeNull();
});
