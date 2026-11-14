import React from "react";
import { renderHook, waitFor } from "@testing-library/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const mockRpc = jest.fn();

jest.mock("@/lib/supabase", () => ({
  supabase: {
    rpc: (fn: string, args: Record<string, unknown>) => mockRpc(fn, args),
  },
}));

jest.mock("@/stores/auth", () => {
  const useAuthStore = jest.fn() as unknown as jest.Mock & {
    getState: jest.Mock;
  };
  useAuthStore.getState = jest.fn(() => ({
    user: { id: "user-1" },
    householdId: "household-1",
  }));
  return { useAuthStore };
});

import { addItemErrorToast, StockUnitMismatchError, useAddItem } from "@/hooks/useAddItem";
import { useAuthStore } from "@/stores/auth";

let client: QueryClient;

function wrapper({ children }: { children: React.ReactNode }) {
  return React.createElement(QueryClientProvider, { client }, children);
}

const validInput = {
  name: "Spinach",
  category_id: "cat-1",
  quantity: 1,
  unit: "bag",
  expiration_date: "2026-06-01",
  storage_location: "fridge" as const,
  notes: null,
  into_lot_id: null,
};

function rpcResolves(lotMerged: boolean) {
  mockRpc.mockResolvedValue({
    data: { food_id: "food-1", lot_id: "lot-1", food_created: !lotMerged, lot_merged: lotMerged },
    error: null,
  });
}

function rpcFailsWith(message: string, details: string | null) {
  mockRpc.mockResolvedValue({ data: null, error: { message, code: "22023", details } });
}

describe("useAddItem", () => {
  beforeEach(() => {
    client = new QueryClient({
      // gcTime: 0 stops cache GC timers from keeping the Jest worker alive.
      defaultOptions: {
        queries: { retry: false, gcTime: 0 },
        mutations: { retry: false, gcTime: 0 },
      },
    });
    mockRpc.mockReset();
    rpcResolves(false);
    (useAuthStore.getState as jest.Mock).mockReturnValue({
      user: { id: "user-1" },
      householdId: "household-1",
    });
  });

  it("adds a counted batch through add_lot with the singular unit as its label", async () => {
    const invalidate = jest.spyOn(client, "invalidateQueries");
    const { result } = renderHook(() => useAddItem(), { wrapper });
    result.current.mutate({ ...validInput, quantity: 2, unit: "Bags" });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(mockRpc).toHaveBeenCalledWith("add_lot", {
      p_household_id: "household-1",
      p_name: "Spinach",
      p_stock_base: "each",
      p_quantity: 2,
      p_storage_location: "fridge",
      p_expiration_date: "2026-06-01",
      p_category_id: "cat-1",
      p_each_label: "bag",
      p_notes: null,
    });
    expect(result.current.data).toEqual({ id: "lot-1", merged: false });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["inventory"] });
  });

  it("converts a table unit into the food's stock base", async () => {
    const { result } = renderHook(() => useAddItem(), { wrapper });
    result.current.mutate({ ...validInput, name: "Rice", quantity: 1.5, unit: "kg" });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(mockRpc).toHaveBeenCalledWith(
      "add_lot",
      expect.objectContaining({ p_stock_base: "g", p_quantity: 1500, p_each_label: null }),
    );
  });

  it("reports a merge into an existing lot", async () => {
    rpcResolves(true);
    const { result } = renderHook(() => useAddItem(), { wrapper });
    result.current.mutate(validInput);

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual({ id: "lot-1", merged: true });
  });

  it.each([
    ["Food 7c1e is stored as each (can)", "can"],
    ["Food 7c1e is stored as ml", "ml"],
  ])("reads the tracked unit from %j", async (details, trackedUnit) => {
    rpcFailsWith("STOCK_BASE_MISMATCH", details);
    const { result } = renderHook(() => useAddItem(), { wrapper });
    result.current.mutate(validInput);

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).toBeInstanceOf(StockUnitMismatchError);
    expect((result.current.error as StockUnitMismatchError).trackedUnit).toBe(trackedUnit);
  });

  it("surfaces other RPC errors unchanged", async () => {
    rpcFailsWith("Quantity must be finite and positive", null);
    const { result } = renderHook(() => useAddItem(), { wrapper });
    result.current.mutate(validInput);

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).not.toBeInstanceOf(StockUnitMismatchError);
    expect(result.current.error?.message).toBe("Quantity must be finite and positive");
  });

  it("adds into an existing container through add_to_lot", async () => {
    mockRpc.mockResolvedValue({ data: null, error: null });
    const invalidate = jest.spyOn(client, "invalidateQueries");
    const { result } = renderHook(() => useAddItem(), { wrapper });
    result.current.mutate({ ...validInput, name: "Horchata", quantity: 1, unit: "l", into_lot_id: "lot-jug" });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(mockRpc).toHaveBeenCalledWith("add_to_lot", {
      p_household_id: "household-1",
      p_lot_id: "lot-jug",
      p_stock_base: "ml",
      p_quantity: 1000,
      p_expiration_date: "2026-06-01",
      p_each_label: null,
    });
    expect(result.current.data).toEqual({ id: "lot-jug", merged: true });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["inventory"] });
  });

  it("reads the tracked unit when a container's food is tracked in another unit", async () => {
    rpcFailsWith("STOCK_BASE_MISMATCH", "Food 7c1e is stored as ml");
    const { result } = renderHook(() => useAddItem(), { wrapper });
    result.current.mutate({ ...validInput, into_lot_id: "lot-jug" });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect((result.current.error as StockUnitMismatchError).trackedUnit).toBe("ml");
  });

  it("says the container changed elsewhere when it is no longer live", async () => {
    rpcFailsWith("LOT_NOT_LIVE", null);
    const { result } = renderHook(() => useAddItem(), { wrapper });
    result.current.mutate({ ...validInput, into_lot_id: "lot-jug" });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(addItemErrorToast(result.current.error!, "Horchata")).toEqual(
      expect.objectContaining({ text1: "Couldn't add Horchata", text2: expect.stringMatching(/another phone/) }),
    );
  });

  it("throws when the user is not signed in", async () => {
    (useAuthStore.getState as jest.Mock).mockReturnValue({
      user: null,
      householdId: null,
    });

    const { result } = renderHook(() => useAddItem(), { wrapper });
    result.current.mutate(validInput);

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error?.message).toBe("not signed in");
    expect(mockRpc).not.toHaveBeenCalled();
  });
});
