import React from "react";
import { renderHook, waitFor } from "@testing-library/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import Toast from "@/lib/toast";

const mockSelect = jest.fn();
const mockInsert = jest.fn();
const mockDelete = jest.fn();

jest.mock("@/lib/supabase", () => ({
  supabase: {
    from: (table: string) => ({
      select: (columns: string) => ({
        eq: (col: string, value: string) => ({
          order: (first: string) => ({
            order: (second: string) => mockSelect(table, columns, col, value, first, second),
          }),
        }),
      }),
      insert: (row: unknown) => mockInsert(table, row),
      delete: () => ({
        eq: (col: string, id: string) => mockDelete(table, col, id),
      }),
    }),
  },
}));
jest.mock("@/lib/toast", () => ({ __esModule: true, default: { show: jest.fn() } }));

const mockHouseholdId = { current: "household-1" as string | null };
jest.mock("@/stores/auth", () => ({
  useAuthStore: jest.fn((selector: (state: { householdId: string | null }) => unknown) =>
    selector({ householdId: mockHouseholdId.current }),
  ),
}));

import {
  useAddKitchenBasic,
  useKitchenBasics,
  useRemoveKitchenBasic,
} from "@/hooks/useKitchenBasics";

const showToast = Toast.show as jest.Mock;
let client: QueryClient;

function wrapper({ children }: { children: React.ReactNode }) {
  return React.createElement(QueryClientProvider, { client }, children);
}

describe("kitchen basics hooks", () => {
  beforeEach(() => {
    // gcTime: 0 stops cache GC timers from keeping the Jest worker alive.
    client = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false, gcTime: 0 } },
    });
    mockSelect.mockReset();
    mockInsert.mockReset();
    mockDelete.mockReset();
    showToast.mockReset();
    mockHouseholdId.current = "household-1";
  });

  it("lists the household's basics oldest first", async () => {
    mockSelect.mockResolvedValue({
      data: [
        { id: "b1", name: "Salt" },
        { id: "b2", name: "Olive oil" },
      ],
      error: null,
    });
    const { result } = renderHook(() => useKitchenBasics(), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual([
      { id: "b1", name: "Salt" },
      { id: "b2", name: "Olive oil" },
    ]);
    expect(mockSelect).toHaveBeenCalledWith(
      "kitchen_basics",
      "id, name",
      "household_id",
      "household-1",
      "created_at",
      "name",
    );
  });

  it("waits for a household before reading", () => {
    mockHouseholdId.current = null;
    const { result } = renderHook(() => useKitchenBasics(), { wrapper });

    expect(result.current.fetchStatus).toBe("idle");
    expect(mockSelect).not.toHaveBeenCalled();
  });

  it("adds a trimmed basic to the household and refreshes the list", async () => {
    mockInsert.mockResolvedValue({ error: null });
    const invalidate = jest.spyOn(client, "invalidateQueries");
    const { result } = renderHook(() => useAddKitchenBasic(), { wrapper });

    result.current.mutate("  Smoked paprika ");

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockInsert).toHaveBeenCalledWith("kitchen_basics", {
      household_id: "household-1",
      name: "Smoked paprika",
    });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["kitchen_basics", "household-1"] });
  });

  it("says when the basic is already on the list", async () => {
    mockInsert.mockResolvedValue({ error: { code: "23505", message: "duplicate key" } });
    const { result } = renderHook(() => useAddKitchenBasic(), { wrapper });

    result.current.mutate("salt");

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(showToast).toHaveBeenCalledWith({
      type: "info",
      text1: "salt is already a basic",
    });
  });

  it("says when the household already has the most basics it may keep", async () => {
    mockInsert.mockResolvedValue({
      error: { code: "23514", message: "KITCHEN_BASICS_FULL" },
    });
    const { result } = renderHook(() => useAddKitchenBasic(), { wrapper });

    result.current.mutate("Butter");

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(showToast).toHaveBeenCalledWith({
      type: "info",
      text1: "Your basics list is full",
      text2: "Remove one to add Butter.",
    });
  });

  it("blames the connection for any other failed add", async () => {
    mockInsert.mockResolvedValue({ error: { code: "08006", message: "offline" } });
    const { result } = renderHook(() => useAddKitchenBasic(), { wrapper });

    result.current.mutate("Butter");

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(showToast).toHaveBeenCalledWith({
      type: "error",
      text1: "Couldn't add Butter",
      text2: "Check your connection and try again.",
    });
  });

  it("removes a basic by id and refreshes the list", async () => {
    mockDelete.mockResolvedValue({ error: null });
    const invalidate = jest.spyOn(client, "invalidateQueries");
    const { result } = renderHook(() => useRemoveKitchenBasic(), { wrapper });

    result.current.mutate({ id: "b1", name: "Salt" });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockDelete).toHaveBeenCalledWith("kitchen_basics", "id", "b1");
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["kitchen_basics", "household-1"] });
  });
});
