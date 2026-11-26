import React from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { act, renderHook, waitFor } from "@testing-library/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ApiError } from "@/lib/api";
import Toast from "@/lib/toast";
import { useActiveCookStore } from "@/stores/activeCook";
import { useAuthStore } from "@/stores/auth";
import type { CookPlan } from "@/types/cook";

const mockApiFetch = jest.fn();
const mockFoodStock = jest.fn();
const mockStockQuery: Record<string, jest.Mock> = {};
const mockUnits: { current: object[] } = { current: [] };

jest.mock("@/lib/supabase", () => ({
  supabase: { from: (table: string) => mockFrom(table) },
}));
jest.mock("@/lib/toast", () => ({ __esModule: true, default: { show: jest.fn() } }));
jest.mock("expo-crypto", () => ({
  randomUUID: () => "11111111-1111-4111-8111-111111111111",
}));
jest.mock("@/lib/api", () => ({
  ...jest.requireActual("@/lib/api"),
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}));

function mockFrom(table: string) {
  if (table === "food_units") {
    return { select: () => ({ eq: async () => ({ data: mockUnits.current, error: null }) }) };
  }
  for (const method of ["select", "eq", "gt"]) {
    mockStockQuery[method] = jest.fn(() => query);
  }
  mockStockQuery.order = jest.fn(async () => mockFoodStock(table));
  const query = mockStockQuery;
  return query;
}

import { useCookChecklist } from "@/hooks/useCookChecklist";

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
        {
          line: 0,
          ingredient: "Eggs",
          recipe_amount: 3,
          recipe_unit: "egg",
          mode: "draw",
          stock_amount: 3,
        },
      ],
    },
  ],
  untracked: [{ line: 1, name: "Salt", reason: "basic" }],
});

const rice = {
  id: "rice",
  name: "Basmati rice",
  stock_base: "g",
  each_label: null,
  whole_units_only: false,
  available: 400,
};

function respond(plans: CookPlan[], confirm: () => unknown) {
  mockApiFetch.mockImplementation(async (path: string) => {
    if (path === "/api/cook/plan") return { data: plans.shift() };
    return confirm();
  });
}

async function setup() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  const invalidate = jest.spyOn(client, "invalidateQueries");
  const onConfirmed = jest.fn();
  const wrapper = ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client }, children);
  const hook = renderHook(() => useCookChecklist({ onConfirmed }), { wrapper });
  await waitFor(() => expect(hook.result.current.status).toBe("ready"));
  await waitFor(() => expect(hook.result.current.addable).toHaveLength(1));
  return { ...hook, invalidate, onConfirmed };
}

beforeEach(async () => {
  mockUnits.current = [];
  jest.clearAllMocks();
  mockFoodStock.mockReturnValue({ data: [rice], error: null });
  await AsyncStorage.clear();
  useAuthStore.setState({ user: { id: "u1" } as never, householdId: "h1" });
  await useActiveCookStore.getState().hydrate("u1", "h1");
  await useActiveCookStore.getState().start("u1", "h1", recipe as never);
});

afterEach(() => useActiveCookStore.getState().leaveScope());

it("plans the active cook's recipe and lists foods in stock for Add item", async () => {
  respond([planWith(6)], () => ({}));

  const { result } = await setup();

  expect(mockApiFetch).toHaveBeenCalledWith("/api/cook/plan", {
    method: "POST",
    body: JSON.stringify({ household_id: "h1", ingredients: recipe.ingredients }),
  });
  expect(result.current.lines.map((l) => [l.name, l.amount, l.available])).toEqual([
    ["Eggs", 3, 6],
  ]);
  expect(result.current.untracked).toEqual([{ line: 1, name: "Salt", reason: "basic" }]);
  expect(mockFoodStock).toHaveBeenCalledWith("food_stock");
  expect(mockStockQuery.eq).toHaveBeenCalledWith("household_id", "h1");
  expect(mockStockQuery.gt).toHaveBeenCalledWith("available", 0);
  expect(result.current.addable).toEqual([
    {
      foodId: "rice",
      name: "Basmati rice",
      stockBase: "g",
      unit: "g",
      available: 400,
      wholeUnitsOnly: false,
      subUnit: null,
    },
  ]);
});

it("gives each line its food's smaller unit", async () => {
  mockUnits.current = [{ food_id: "eggs", unit_key: "half", base_per_unit: 0.5 }];
  respond([planWith(6)], () => ({}));
  const { result } = await setup();

  await waitFor(() =>
    expect(result.current.lines[0].subUnit).toEqual({ label: "half", perUnit: 0.5 }),
  );
});

it("deducts the confirmed amounts, refreshes the inventory and ends the cook", async () => {
  respond([planWith(6)], () => ({ data: {} }));
  const { result, invalidate, onConfirmed } = await setup();

  act(() => result.current.setAmount("eggs", 2));
  await act(() => result.current.confirm());

  const [path, init] = mockApiFetch.mock.calls[1];
  expect(path).toBe("/api/cook/confirm");
  expect(JSON.parse(init.body)).toMatchObject({
    operation_id: "11111111-1111-4111-8111-111111111111",
    deductions: [{ inventory_item_id: "eggs", confirmed_amount: 2, expected_amount: 2 }],
  });
  expect(invalidate).toHaveBeenCalledWith({ queryKey: ["inventory"] });
  expect(onConfirmed).toHaveBeenCalledWith(recipe);
  expect(Toast.show).not.toHaveBeenCalled();
  expect(useActiveCookStore.getState().activeCook).toBeNull();
});

it("ends the cook when an earlier attempt already confirmed it", async () => {
  respond([planWith(6)], () => {
    throw new ApiError(409, "This cook was already confirmed", "COOK_ALREADY_CONFIRMED");
  });
  const { result, onConfirmed } = await setup();

  await act(() => result.current.confirm());

  expect(onConfirmed).toHaveBeenCalledWith(recipe);
  expect(useActiveCookStore.getState().activeCook).toBeNull();
});

it("reloads stock and marks the changed lines when another cook got there first", async () => {
  respond([planWith(6), planWith(2)], () => {
    throw new ApiError(409, "Some ingredients changed", "STOCK_CHANGED");
  });
  const { result } = await setup();
  act(() =>
    result.current.addFood({
      foodId: "rice",
      name: "Basmati rice",
      stockBase: "g",
      unit: "g",
      available: 400,
      wholeUnitsOnly: false,
      subUnit: null,
    }),
  );
  mockFoodStock.mockReturnValue({ data: [], error: null });

  await act(() => result.current.confirm());

  expect(result.current.stockChanged).toBe(true);
  expect(result.current.lines.map((l) => [l.foodId, l.amount, l.available, l.changed])).toEqual([
    ["eggs", 3, 2, "Only 2 eggs left now"],
    ["rice", 5, 0, "None left now"],
  ]);
  expect(useActiveCookStore.getState().activeCook?.recipe.recipe_id).toBe("r1");

  act(() => result.current.setAmount("eggs", 2));
  expect(result.current.lines[0].changed).toBeNull();
});

it("keeps the cook and explains when stock can't be reloaded after a refusal", async () => {
  respond([planWith(6), planWith(2)], () => {
    throw new ApiError(409, "Some ingredients changed", "STOCK_CHANGED");
  });
  const { result } = await setup();
  mockFoodStock.mockReturnValue({ data: null, error: new Error("offline") });

  await act(() => result.current.confirm());

  expect(result.current.stockChanged).toBe(false);
  expect(Toast.show).toHaveBeenCalledWith(
    expect.objectContaining({ type: "error", text1: "Couldn't update your kitchen" }),
  );
  expect(useActiveCookStore.getState().activeCook).not.toBeNull();
});

it("keeps the cook and explains when the kitchen can't be updated", async () => {
  respond([planWith(6)], () => {
    throw new ApiError(503, "Cook service unavailable", "COOK_UNAVAILABLE");
  });
  const { result } = await setup();

  await act(() => result.current.confirm());

  expect(Toast.show).toHaveBeenCalledWith(
    expect.objectContaining({ type: "error", text1: "Couldn't update your kitchen" }),
  );
  expect(useActiveCookStore.getState().activeCook).not.toBeNull();
});

it("adds and removes foods the recipe didn't list", async () => {
  respond([planWith(6)], () => ({}));
  const { result } = await setup();

  act(() => result.current.addFood(result.current.addable[0]));
  expect(result.current.lines.map((l) => [l.foodId, l.amount])).toEqual([
    ["eggs", 3],
    ["rice", 5],
  ]);

  act(() => result.current.removeFood("rice"));
  expect(result.current.lines.map((l) => l.foodId)).toEqual(["eggs"]);
});
