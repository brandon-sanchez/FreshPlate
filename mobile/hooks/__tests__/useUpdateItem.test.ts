import React from "react";
import { renderHook, waitFor } from "@testing-library/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

type Write = { table: string; payload: Record<string, unknown>; id: string };

const mockWrites: Write[] = [];
const mockErrors: Record<string, { message: string; code?: string } | null> = {};

jest.mock("@/lib/supabase", () => ({
  supabase: {
    from: (table: string) => ({
      update: (payload: Record<string, unknown>) => ({
        eq: async (_col: string, id: string) => {
          mockWrites.push({ table, payload, id });
          return { error: mockErrors[table] ?? null };
        },
      }),
    }),
  },
}));

import { FoodNameTakenError, useUpdateItem } from "@/hooks/useUpdateItem";

function wrapper({ children }: { children: React.ReactNode }) {
  const client = new QueryClient({
    // gcTime: 0 stops cache GC timers from keeping the Jest worker alive.
    defaultOptions: { mutations: { retry: false, gcTime: 0 } },
  });
  return React.createElement(QueryClientProvider, { client }, children);
}

describe("useUpdateItem", () => {
  beforeEach(() => {
    mockWrites.length = 0;
    mockErrors.lots = null;
    mockErrors.foods = null;
  });

  it("writes lot fields to the lot and the name to its food", async () => {
    const { result } = renderHook(() => useUpdateItem(), { wrapper });
    result.current.mutate({
      id: "lot-1",
      foodId: "food-1",
      patch: {
        name: "Baby spinach",
        expiration_date: "2026-06-04",
        storage_location: "freezer",
        notes: null,
      },
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockWrites).toEqual([
      { table: "foods", payload: { name: "Baby spinach" }, id: "food-1" },
      {
        table: "lots",
        payload: { expiration_date: "2026-06-04", storage_location: "freezer", notes: null },
        id: "lot-1",
      },
    ]);
  });

  it("skips the lot write when only the name changed", async () => {
    const { result } = renderHook(() => useUpdateItem(), { wrapper });
    result.current.mutate({ id: "lot-1", foodId: "food-1", patch: { name: "Kale" } });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockWrites).toEqual([{ table: "foods", payload: { name: "Kale" }, id: "food-1" }]);
  });

  it("saves a batch's date, location and notes to its lot alone", async () => {
    const { result } = renderHook(() => useUpdateItem(), { wrapper });
    result.current.mutate({
      id: "lot-1",
      foodId: "food-1",
      patch: { expiration_date: null, storage_location: "pantry", notes: "half left" },
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockWrites).toEqual([
      {
        table: "lots",
        payload: { expiration_date: null, storage_location: "pantry", notes: "half left" },
        id: "lot-1",
      },
    ]);
  });

  it("surfaces a failed lot write", async () => {
    mockErrors.lots = { message: "permission denied for table lots" };
    const { result } = renderHook(() => useUpdateItem(), { wrapper });
    result.current.mutate({ id: "lot-1", foodId: "food-1", patch: { notes: "opened" } });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error?.message).toBe("permission denied for table lots");
  });

  it("stops before the lot write when another food has the name", async () => {
    mockErrors.foods = { message: "duplicate key value", code: "23505" };
    const { result } = renderHook(() => useUpdateItem(), { wrapper });
    result.current.mutate({
      id: "lot-1",
      foodId: "food-1",
      patch: { name: "Eggs", notes: "opened" },
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).toBeInstanceOf(FoodNameTakenError);
    expect(mockWrites).toEqual([{ table: "foods", payload: { name: "Eggs" }, id: "food-1" }]);
  });
});
