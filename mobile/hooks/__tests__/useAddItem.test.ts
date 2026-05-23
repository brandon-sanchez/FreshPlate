import React from "react";
import { renderHook, waitFor } from "@testing-library/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const mockInsert = jest.fn();
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
    mockInsert.mockReset();
    mockFrom.mockClear();
    (useAuthStore.getState as jest.Mock).mockReturnValue({
      user: { id: "user-1" },
      householdId: "household-1",
    });
  });

  it("inserts the item with household_id and added_by from auth store", async () => {
    mockInsert.mockResolvedValue({ error: null });

    const { result } = renderHook(() => useAddItem(), { wrapper });
    result.current.mutate(validInput);

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(mockFrom).toHaveBeenCalledWith("inventory_items");
    expect(mockInsert).toHaveBeenCalledWith({
      ...validInput,
      household_id: "household-1",
      added_by: "user-1",
    });
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
    mockInsert.mockResolvedValue({ error: new Error("RLS denied") });

    const { result } = renderHook(() => useAddItem(), { wrapper });
    result.current.mutate(validInput);

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error?.message).toBe("RLS denied");
  });
});
