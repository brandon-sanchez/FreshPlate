import React from "react";
import { renderHook, waitFor } from "@testing-library/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// Final node of the chain — `await`ed by the hook. We swap its resolved value per-test.
const mockOrder = jest.fn();
const mockIs = jest.fn((_col: string, _val: unknown) => ({ order: mockOrder }));
const mockEq = jest.fn((_col: string, _val: unknown) => ({ is: mockIs }));
const mockSelect = jest.fn((_cols: string) => ({ eq: mockEq }));
const mockFrom = jest.fn((_table: string) => ({ select: mockSelect }));

jest.mock("@/lib/supabase", () => ({
  supabase: { from: (table: string) => mockFrom(table) },
}));

// useInventoryItems uses the *selector* form: useAuthStore(s => s.householdId).
// Our mock implements the selector signature.
const mockHouseholdId = { current: "household-1" as string | null };
jest.mock("@/stores/auth", () => ({
  useAuthStore: jest.fn(
    (selector: (state: { householdId: string | null }) => unknown) =>
      selector({ householdId: mockHouseholdId.current }),
  ),
}));

import { useInventoryItems } from "@/hooks/useInventoryItems";

function wrapper({ children }: { children: React.ReactNode }) {
  const client = new QueryClient({
    // gcTime: 0 stops cache GC timers from keeping the Jest worker alive.
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return React.createElement(QueryClientProvider, { client }, children);
}

const spinachLot = {
  id: "lot-1",
  quantity: 1,
  expiration_date: "2026-06-01",
  storage_location: "fridge",
  notes: null,
  added_by: "u1",
  opened_at: "2026-05-30T09:15:00+00:00",
  created_at: "2026-05-28T18:00:00+00:00",
  updated_at: "2026-05-30T09:15:00.654321+00:00",
  initial_quantity: 2,
  is_estimate: true,
  food: {
    id: "food-1",
    name: "Spinach",
    stock_base: "each",
    each_label: "bag",
    whole_units_only: true,
    category: { id: "c1", name: "Produce", icon: "leaf" },
  },
};

const soupLot = {
  id: "lot-2",
  quantity: 750,
  expiration_date: null,
  storage_location: "freezer",
  notes: "Tuesday's batch",
  added_by: null,
  opened_at: null,
  created_at: "2026-05-29T20:30:00+00:00",
  updated_at: "2026-05-29T20:30:00+00:00",
  initial_quantity: null,
  is_estimate: false,
  food: {
    id: "food-2",
    name: "Chicken soup",
    stock_base: "ml",
    each_label: null,
    whole_units_only: false,
    category: { id: "c2", name: "Leftovers", icon: "inbox" },
  },
};

describe("useInventoryItems", () => {
  beforeEach(() => {
    mockFrom.mockClear();
    mockSelect.mockClear();
    mockEq.mockClear();
    mockIs.mockClear();
    mockOrder.mockReset();
    mockHouseholdId.current = "household-1";
  });

  it("reads the household's live lots with their food, soonest expiry first", async () => {
    mockOrder.mockResolvedValue({ data: [], error: null });

    const { result } = renderHook(() => useInventoryItems(), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(mockFrom).toHaveBeenCalledWith("lots");
    expect(mockSelect.mock.calls[0][0].replace(/\s+/g, " ").trim()).toBe(
      "id, quantity, initial_quantity, is_estimate, expiration_date, storage_location, notes, " +
        "added_by, opened_at, created_at, updated_at, " +
        "food:food_stock!inner(id, name, stock_base, each_label, whole_units_only, " +
        "category:food_categories(id, name, icon))",
    );
    expect(mockEq).toHaveBeenCalledWith("household_id", "household-1");
    expect(mockIs).toHaveBeenCalledWith("depleted_at", null);
    expect(mockOrder).toHaveBeenCalledWith("expiration_date", {
      ascending: true,
      nullsFirst: false,
    });
  });

  it("maps each lot into one inventory row named and unitized by its food, with its opened and added times", async () => {
    mockOrder.mockResolvedValue({ data: [spinachLot, soupLot], error: null });

    const { result } = renderHook(() => useInventoryItems(), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data).toEqual([
      {
        id: "lot-1",
        food_id: "food-1",
        name: "Spinach",
        quantity: 1,
        initial_quantity: 2,
        is_estimate: true,
        unit: "bag",
        whole_units_only: true,
        expiration_date: "2026-06-01",
        storage_location: "fridge",
        is_leftover: false,
        notes: null,
        added_by: "u1",
        opened_at: "2026-05-30T09:15:00+00:00",
        created_at: "2026-05-28T18:00:00+00:00",
        updated_at: "2026-05-30T09:15:00.654321+00:00",
        category: { id: "c1", name: "Produce", icon: "leaf" },
      },
      {
        id: "lot-2",
        food_id: "food-2",
        name: "Chicken soup",
        quantity: 750,
        initial_quantity: null,
        is_estimate: false,
        unit: "ml",
        whole_units_only: false,
        expiration_date: null,
        storage_location: "freezer",
        is_leftover: true,
        notes: "Tuesday's batch",
        added_by: null,
        opened_at: null,
        created_at: "2026-05-29T20:30:00+00:00",
        updated_at: "2026-05-29T20:30:00+00:00",
        category: { id: "c2", name: "Leftovers", icon: "inbox" },
      },
    ]);
  });

  it("does not fetch while householdId is null (auth still loading)", async () => {
    mockHouseholdId.current = null;
    mockOrder.mockResolvedValue({ data: [], error: null });

    const { result } = renderHook(() => useInventoryItems(), { wrapper });

    // Give React Query a microtask to settle. Should remain pending without firing.
    await new Promise((r) => setTimeout(r, 0));
    expect(mockFrom).not.toHaveBeenCalled();
    expect(result.current.fetchStatus).toBe("idle");
  });

  it("surfaces supabase errors via the query error state", async () => {
    mockOrder.mockResolvedValue({
      data: null,
      error: { message: "RLS denied", code: "P000", details: undefined },
    });

    const { result } = renderHook(() => useInventoryItems(), { wrapper });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error?.message).toBe("RLS denied");
  });
});
