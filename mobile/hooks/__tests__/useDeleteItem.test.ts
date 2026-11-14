import React from "react";
import { renderHook, waitFor } from "@testing-library/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const mockDelete = jest.fn();

jest.mock("@/lib/supabase", () => ({
  supabase: {
    from: (table: string) => ({
      delete: () => ({ eq: (col: string, id: string) => mockDelete(table, col, id) }),
    }),
  },
}));

import { useDeleteItem } from "@/hooks/useDeleteItem";

function wrapper({ children }: { children: React.ReactNode }) {
  const client = new QueryClient({
    // gcTime: 0 stops cache GC timers from keeping the Jest worker alive.
    defaultOptions: { mutations: { retry: false, gcTime: 0 } },
  });
  return React.createElement(QueryClientProvider, { client }, children);
}

describe("useDeleteItem", () => {
  beforeEach(() => mockDelete.mockReset());

  it("deletes the lot by id", async () => {
    mockDelete.mockResolvedValue({ error: null });
    const { result } = renderHook(() => useDeleteItem(), { wrapper });
    result.current.mutate("lot-1");

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockDelete).toHaveBeenCalledWith("lots", "id", "lot-1");
  });

  it("fails when the database refuses the delete", async () => {
    mockDelete.mockResolvedValue({ error: { message: "permission denied for table lots" } });
    const { result } = renderHook(() => useDeleteItem(), { wrapper });
    result.current.mutate("lot-1");

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error?.message).toBe("permission denied for table lots");
  });
});
