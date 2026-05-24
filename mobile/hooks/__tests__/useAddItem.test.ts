import React from "react";
import { renderHook, waitFor } from "@testing-library/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

type SupaResult<T> = { data: T | null; error: Error | null };

let mockLookupResult: SupaResult<{
  id: string;
  quantity: number;
  expiration_date: string | null;
}> = { data: null, error: null };
let mockInsertResult: SupaResult<{ id: string }> = {
  data: { id: "inserted-id" },
  error: null,
};
let mockUpdateResult: SupaResult<{ id: string }> = {
  data: { id: "updated-id" },
  error: null,
};

let lastInsertPayload: Record<string, unknown> | null = null;
let lastUpdatePayload: Record<string, unknown> | null = null;
let updateMatchedId: string | null = null;
let insertCallCount = 0;
let updateCallCount = 0;

function buildQueryBuilder() {
  let didInsert = false;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const b: any = {};
  const chain = ["select", "eq", "ilike", "is", "limit"] as const;
  chain.forEach((m) => {
    b[m] = jest.fn(() => b);
  });
  b.insert = jest.fn((payload: Record<string, unknown>) => {
    didInsert = true;
    lastInsertPayload = payload;
    insertCallCount += 1;
    return b;
  });
  b.update = jest.fn((payload: Record<string, unknown>) => {
    lastUpdatePayload = payload;
    updateCallCount += 1;
    // capture the next .eq("id", ...) call so we can assert it
    const origEq = b.eq;
    b.eq = jest.fn((col: string, val: string) => {
      if (col === "id") updateMatchedId = val;
      return origEq(col, val);
    });
    return b;
  });
  b.maybeSingle = jest.fn(async () => mockLookupResult);
  b.single = jest.fn(async () => (didInsert ? mockInsertResult : mockUpdateResult));
  return b;
}

const mockFrom = jest.fn((_table: string) => buildQueryBuilder());

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
    mockFrom.mockClear();
    lastInsertPayload = null;
    lastUpdatePayload = null;
    updateMatchedId = null;
    insertCallCount = 0;
    updateCallCount = 0;
    mockLookupResult = { data: null, error: null };
    mockInsertResult = { data: { id: "inserted-id" }, error: null };
    mockUpdateResult = { data: { id: "updated-id" }, error: null };
    (useAuthStore.getState as jest.Mock).mockReturnValue({
      user: { id: "user-1" },
      householdId: "household-1",
    });
  });

  it("inserts a new row when no matching item exists (merged: false)", async () => {
    const { result } = renderHook(() => useAddItem(), { wrapper });
    result.current.mutate(validInput);

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(insertCallCount).toBe(1);
    expect(updateCallCount).toBe(0);
    expect(lastInsertPayload).toEqual({
      ...validInput,
      household_id: "household-1",
      added_by: "user-1",
    });
    expect(result.current.data).toEqual({ id: "inserted-id", merged: false });
  });

  it("updates the existing row when a match is found (merged: true) with summed quantity and earlier expiration", async () => {
    mockLookupResult = {
      data: { id: "existing-1", quantity: 2, expiration_date: "2026-05-25" },
      error: null,
    };
    mockUpdateResult = { data: { id: "existing-1" }, error: null };

    const { result } = renderHook(() => useAddItem(), { wrapper });
    result.current.mutate(validInput);

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(updateCallCount).toBe(1);
    expect(insertCallCount).toBe(0);
    expect(lastUpdatePayload).toEqual({
      quantity: 3,
      expiration_date: "2026-05-25",
    });
    expect(updateMatchedId).toBe("existing-1");
    expect(result.current.data).toEqual({ id: "existing-1", merged: true });
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
    expect(insertCallCount).toBe(0);
    expect(updateCallCount).toBe(0);
  });

  it("surfaces supabase lookup errors via the mutation error state", async () => {
    mockLookupResult = { data: null, error: new Error("RLS denied on select") };

    const { result } = renderHook(() => useAddItem(), { wrapper });
    result.current.mutate(validInput);

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error?.message).toBe("RLS denied on select");
    expect(insertCallCount).toBe(0);
    expect(updateCallCount).toBe(0);
  });

  it("surfaces supabase insert errors via the mutation error state", async () => {
    mockInsertResult = { data: null, error: new Error("RLS denied on insert") };

    const { result } = renderHook(() => useAddItem(), { wrapper });
    result.current.mutate(validInput);

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error?.message).toBe("RLS denied on insert");
    expect(insertCallCount).toBe(1);
  });
});
