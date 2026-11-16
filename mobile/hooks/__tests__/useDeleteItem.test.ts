import React from "react";
import { renderHook, waitFor } from "@testing-library/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import Toast from "@/lib/toast";

const mockDelete = jest.fn();

jest.mock("@/lib/supabase", () => ({
  supabase: {
    from: (table: string) => ({
      delete: () => ({
        eq: (col: string, id: string) => ({
          select: (columns: string) => mockDelete(table, col, id, columns),
        }),
      }),
    }),
  },
}));
jest.mock("@/lib/toast", () => ({ __esModule: true, default: { show: jest.fn() } }));

import { useDeleteItem } from "@/hooks/useDeleteItem";

const showToast = Toast.show as jest.Mock;
let client: QueryClient;

function wrapper({ children }: { children: React.ReactNode }) {
  return React.createElement(QueryClientProvider, { client }, children);
}

describe("useDeleteItem", () => {
  beforeEach(() => {
    // gcTime: 0 stops cache GC timers from keeping the Jest worker alive.
    client = new QueryClient({ defaultOptions: { mutations: { retry: false, gcTime: 0 } } });
    mockDelete.mockReset();
    showToast.mockReset();
  });

  it("deletes the lot by id and says so", async () => {
    mockDelete.mockResolvedValue({ data: [{ id: "lot-1" }], error: null });
    const invalidate = jest.spyOn(client, "invalidateQueries");
    const { result } = renderHook(() => useDeleteItem(), { wrapper });
    result.current.mutate({ id: "lot-1", name: "Milk" });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockDelete).toHaveBeenCalledWith("lots", "id", "lot-1", "id");
    expect(showToast).toHaveBeenCalledWith({ type: "success", text1: "Deleted" });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["inventory"] });
  });

  it("says another phone changed the batch when the delete matches no row", async () => {
    mockDelete.mockResolvedValue({ data: [], error: null });
    const invalidate = jest.spyOn(client, "invalidateQueries");
    const { result } = renderHook(() => useDeleteItem(), { wrapper });
    result.current.mutate({ id: "lot-1", name: "Milk" });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(showToast).toHaveBeenCalledTimes(1);
    expect(showToast).toHaveBeenCalledWith({
      type: "error",
      text1: "Milk already changed",
      text2: "It was updated on another phone.",
    });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["inventory"] });
  });

  it("blames the connection when the database refuses the delete", async () => {
    mockDelete.mockResolvedValue({
      data: null,
      error: { message: "permission denied for table lots" },
    });
    const { result } = renderHook(() => useDeleteItem(), { wrapper });
    result.current.mutate({ id: "lot-1", name: "Milk" });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error?.message).toBe("permission denied for table lots");
    expect(showToast).toHaveBeenCalledWith({
      type: "error",
      text1: "Couldn't delete",
      text2: "Check your connection and try again.",
    });
  });
});
