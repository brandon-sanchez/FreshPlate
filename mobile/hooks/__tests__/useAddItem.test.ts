import React from "react";
import { renderHook, waitFor } from "@testing-library/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const mockSingle = jest.fn();
const mockSelect = jest.fn((_cols: string) => ({ single: mockSingle }));
const mockInsert = jest.fn((_payload: unknown) => ({ select: mockSelect }));
const mockFrom = jest.fn((_table: string) => ({ insert: mockInsert }));

jest.mock("@/lib/supabase", () => ({
  supabase: { from: (table: string) => mockFrom(table) },
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

import { useAddItem } from "@/hooks/useAddItem";
import { useAuthStore } from "@/stores/auth";

function wrapper({ children }: { children: React.ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
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
};

describe("useAddItem", () => {
  beforeEach(() => {
    mockSingle.mockReset();
    mockSelect.mockClear();
    mockInsert.mockClear();
    mockFrom.mockClear();
    (useAuthStore.getState as jest.Mock).mockReturnValue({
      user: { id: "user-1" },
      householdId: "household-1",
    });
  });

  it("inserts the item with household_id and added_by and resolves with the new id", async () => {
    mockSingle.mockResolvedValue({ data: { id: "new-item-1" }, error: null });

    const { result } = renderHook(() => useAddItem(), { wrapper });
    result.current.mutate(validInput);

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(mockFrom).toHaveBeenCalledWith("inventory_items");
    expect(mockInsert).toHaveBeenCalledWith({
      ...validInput,
      household_id: "household-1",
      added_by: "user-1",
    });
    expect(mockSelect).toHaveBeenCalledWith("id");
    expect(result.current.data).toEqual({ id: "new-item-1" });
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
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it("surfaces supabase errors via the mutation error state", async () => {
    mockSingle.mockResolvedValue({ data: null, error: new Error("RLS denied") });

    const { result } = renderHook(() => useAddItem(), { wrapper });
    result.current.mutate(validInput);

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error?.message).toBe("RLS denied");
  });
});
