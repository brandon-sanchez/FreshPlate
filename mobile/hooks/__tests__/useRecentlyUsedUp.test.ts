import React from "react";
import { act, renderHook, waitFor } from "@testing-library/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import Toast from "@/lib/toast";

const mockOrder = jest.fn();
const mockEq = jest.fn((_col: string, _val: unknown) => ({ order: mockOrder }));
const mockSelect = jest.fn((_cols: string) => ({ eq: mockEq }));
const mockFrom = jest.fn((_table: string) => ({ select: mockSelect }));
const mockRpc = jest.fn();

jest.mock("@/lib/supabase", () => ({
  supabase: {
    from: (table: string) => mockFrom(table),
    rpc: (...args: unknown[]) => mockRpc(...args),
  },
}));
jest.mock("@/stores/auth", () => ({
  useAuthStore: (selector: (s: { householdId: string }) => unknown) =>
    selector({ householdId: "household-1" }),
}));
jest.mock("@/lib/toast", () => ({ __esModule: true, default: { show: jest.fn() } }));

import { type UsedUpFood, useRecentlyUsedUp, useRestoreUsedUp } from "@/hooks/useRecentlyUsedUp";

const showToast = Toast.show as jest.Mock;
let client: QueryClient;

function wrapper({ children }: { children: React.ReactNode }) {
  return React.createElement(QueryClientProvider, { client }, children);
}

const eggsRow = {
  lot_id: "lot-1",
  food_id: "food-1",
  name: "Eggs",
  stock_base: "each",
  each_label: "egg",
  whole_units_only: true,
  depleted_at: "2026-11-16T18:00:00+00:00",
};
const milkRow = {
  lot_id: "lot-2",
  food_id: "food-2",
  name: "Milk",
  stock_base: "ml",
  each_label: null,
  whole_units_only: false,
  depleted_at: "2026-11-15T08:00:00+00:00",
};

beforeEach(() => {
  client = new QueryClient({
    // gcTime: 0 stops cache GC timers from keeping the Jest worker alive.
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false, gcTime: 0 } },
  });
  jest.clearAllMocks();
  mockOrder.mockResolvedValue({ data: [eggsRow, milkRow], error: null });
});

it("reads the household's used-up foods, most recent first, in their stock units", async () => {
  const { result } = renderHook(() => useRecentlyUsedUp(), { wrapper });

  await waitFor(() => expect(result.current.isSuccess).toBe(true));

  expect(mockFrom).toHaveBeenCalledWith("recently_used_up");
  expect(mockEq).toHaveBeenCalledWith("household_id", "household-1");
  expect(mockOrder).toHaveBeenCalledWith("depleted_at", { ascending: false });
  expect(result.current.data).toEqual([
    {
      lotId: "lot-1",
      foodId: "food-1",
      name: "Eggs",
      unit: "egg",
      wholeUnitsOnly: true,
      depletedAt: "2026-11-16T18:00:00+00:00",
    },
    {
      lotId: "lot-2",
      foodId: "food-2",
      name: "Milk",
      unit: "ml",
      wholeUnitsOnly: false,
      depletedAt: "2026-11-15T08:00:00+00:00",
    },
  ]);
});

const eggs: UsedUpFood = {
  lotId: "lot-1",
  foodId: "food-1",
  name: "Eggs",
  unit: "egg",
  wholeUnitsOnly: true,
  depletedAt: "2026-11-16T18:00:00+00:00",
};

it("restores a food with the amount left, then refreshes the inventory before reporting it", async () => {
  mockRpc.mockResolvedValue({ error: null });
  const invalidate = jest.spyOn(client, "invalidateQueries");
  const onRestored = jest.fn(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ["inventory"] }));
  const { result } = renderHook(() => useRestoreUsedUp({ onRestored }), { wrapper });

  act(() => result.current.mutate({ food: eggs, quantity: 4 }));

  await waitFor(() => expect(onRestored).toHaveBeenCalledWith("lot-1"));
  expect(mockRpc).toHaveBeenCalledWith("restore_used_up_lot", {
    p_household_id: "household-1",
    p_lot_id: "lot-1",
    p_quantity: 4,
  });
  expect(showToast).toHaveBeenCalledWith({ type: "success", text1: "Eggs restored" });
});

it("says another phone got there first when the food is no longer restorable", async () => {
  mockRpc.mockResolvedValue({ error: { message: "LOT_NOT_RESTORABLE" } });
  const invalidate = jest.spyOn(client, "invalidateQueries");
  const onRestored = jest.fn();
  const { result } = renderHook(() => useRestoreUsedUp({ onRestored }), { wrapper });

  act(() => result.current.mutate({ food: eggs, quantity: 2 }));

  await waitFor(() => expect(result.current.isError).toBe(true));
  expect(showToast).toHaveBeenCalledWith({
    type: "error",
    text1: "Eggs already changed",
    text2: "It was updated on another phone.",
  });
  expect(invalidate).toHaveBeenCalledWith({ queryKey: ["inventory"] });
  expect(onRestored).not.toHaveBeenCalled();
});

it("blames the connection when the restore fails for another reason", async () => {
  mockRpc.mockResolvedValue({ error: { message: "Failed to fetch" } });
  const { result } = renderHook(() => useRestoreUsedUp({ onRestored: jest.fn() }), { wrapper });

  act(() => result.current.mutate({ food: eggs, quantity: 2 }));

  await waitFor(() => expect(result.current.isError).toBe(true));
  expect(showToast).toHaveBeenCalledWith({
    type: "error",
    text1: "Couldn't update Eggs",
    text2: "Check your connection and try again.",
  });
});
