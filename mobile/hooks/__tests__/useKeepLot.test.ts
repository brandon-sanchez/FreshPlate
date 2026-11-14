import React from "react";
import { renderHook, waitFor } from "@testing-library/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import Toast from "react-native-toast-message";

const mockUpdate = jest.fn();

jest.mock("@/lib/supabase", () => ({
  supabase: {
    from: (table: string) => ({
      update: (patch: unknown) => ({
        eq: (col: string, id: string) => ({
          is: (nullCol: string, value: null) => ({
            select: (columns: string) =>
              mockUpdate({ table, patch, eq: [col, id], is: [nullCol, value], columns }),
          }),
        }),
      }),
    }),
  },
}));
jest.mock("react-native-toast-message", () => ({ __esModule: true, default: { show: jest.fn() } }));

import { useKeepLot } from "@/hooks/useKeepLot";

const showToast = Toast.show as jest.Mock;
let client: QueryClient;

function wrapper({ children }: { children: React.ReactNode }) {
  return React.createElement(QueryClientProvider, { client }, children);
}

describe("useKeepLot", () => {
  beforeEach(() => {
    // gcTime: 0 stops cache GC timers from keeping the Jest worker alive.
    client = new QueryClient({ defaultOptions: { mutations: { retry: false, gcTime: 0 } } });
    mockUpdate.mockReset();
    showToast.mockReset();
  });

  it("gives a live batch its new date and says until when", async () => {
    mockUpdate.mockResolvedValue({ data: [{ id: "lot-1" }], error: null });
    const invalidate = jest.spyOn(client, "invalidateQueries");
    const { result } = renderHook(() => useKeepLot(), { wrapper });
    result.current.mutate({ id: "lot-1", name: "Milk", expirationDate: "2026-11-20" });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockUpdate).toHaveBeenCalledWith({
      table: "lots",
      patch: { expiration_date: "2026-11-20" },
      eq: ["id", "lot-1"],
      is: ["depleted_at", null],
      columns: "id",
    });
    expect(showToast).toHaveBeenCalledWith({
      type: "success",
      text1: "Milk kept",
      text2: `Good until ${new Date(2026, 10, 20).toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
      })}`,
    });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["inventory"] });
  });

  it("says another phone changed the batch when it is no longer live", async () => {
    mockUpdate.mockResolvedValue({ data: [], error: null });
    const invalidate = jest.spyOn(client, "invalidateQueries");
    const { result } = renderHook(() => useKeepLot(), { wrapper });
    result.current.mutate({ id: "lot-1", name: "Milk", expirationDate: "2026-11-20" });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(showToast).toHaveBeenCalledWith({
      type: "error",
      text1: "Milk already changed",
      text2: "It was updated on another phone.",
    });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["inventory"] });
  });

  it("blames the connection when the update fails", async () => {
    mockUpdate.mockResolvedValue({ data: null, error: { message: "Network request failed" } });
    const { result } = renderHook(() => useKeepLot(), { wrapper });
    result.current.mutate({ id: "lot-1", name: "Milk", expirationDate: "2026-11-20" });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(showToast).toHaveBeenCalledWith({
      type: "error",
      text1: "Couldn't update Milk",
      text2: "Check your connection and try again.",
    });
  });
});
