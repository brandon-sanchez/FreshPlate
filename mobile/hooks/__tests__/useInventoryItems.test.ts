import React from "react";
import { renderHook, waitFor } from "@testing-library/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// Final node of the chain — `await`ed by the hook. We swap its resolved value per-test.
const mockOrder = jest.fn();
const mockEq = jest.fn((_col: string, _val: unknown) => ({ order: mockOrder }));
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

import {
  daysUntilExpiration,
  useInventoryItems,
} from "@/hooks/useInventoryItems";

function wrapper({ children }: { children: React.ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return React.createElement(QueryClientProvider, { client }, children);
}

const fixtureRow = {
  id: "i1",
  name: "Spinach",
  quantity: 1,
  unit: "bag",
  expiration_date: "2026-06-01",
  storage_location: "fridge",
  is_leftover: false,
  notes: null,
  added_by: "u1",
  category: { id: "c1", name: "Produce", icon: "leaf" },
};

describe("useInventoryItems", () => {
  beforeEach(() => {
    mockFrom.mockClear();
    mockSelect.mockClear();
    mockEq.mockClear();
    mockOrder.mockReset();
    mockHouseholdId.current = "household-1";
  });

  it("fetches items scoped to the household and resolves with the rows", async () => {
    mockOrder.mockResolvedValue({ data: [fixtureRow], error: null });

    const { result } = renderHook(() => useInventoryItems(), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(mockFrom).toHaveBeenCalledWith("inventory_items");
    expect(mockEq).toHaveBeenCalledWith("household_id", "household-1");
    expect(result.current.data).toEqual([fixtureRow]);
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
    mockOrder.mockResolvedValue({ data: null, error: new Error("RLS denied") });

    const { result } = renderHook(() => useInventoryItems(), { wrapper });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error?.message).toBe("RLS denied");
  });
});

describe("daysUntilExpiration", () => {
  function localDateString(date: Date): string {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, "0");
    const d = String(date.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }

  it("returns null when expiration_date is null", () => {
    expect(daysUntilExpiration(null)).toBeNull();
  });

  it("returns 0 when expiration is today", () => {
    expect(daysUntilExpiration(localDateString(new Date()))).toBe(0);
  });

  it("returns a negative number when expiration is in the past", () => {
    const past = new Date();
    past.setDate(past.getDate() - 3);
    expect(daysUntilExpiration(localDateString(past))).toBe(-3);
  });

  it("returns a positive number when expiration is in the future", () => {
    const future = new Date();
    future.setDate(future.getDate() + 7);
    expect(daysUntilExpiration(localDateString(future))).toBe(7);
  });
});
