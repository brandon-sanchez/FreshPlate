import React from "react";
import { act, renderHook, waitFor } from "@testing-library/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import Toast from "react-native-toast-message";

const mockRpc = jest.fn();

jest.mock("@/lib/supabase", () => ({
  supabase: { rpc: (...args: unknown[]) => mockRpc(...args) },
}));
jest.mock("@/stores/auth", () => ({
  useAuthStore: (selector: (s: { householdId: string }) => unknown) =>
    selector({ householdId: "household-1" }),
}));
jest.mock("react-native-toast-message", () => ({ __esModule: true, default: { show: jest.fn() } }));

import { useCutLot } from "@/hooks/useCutLot";

const showToast = Toast.show as jest.Mock;

function setup<T>(hook: () => T) {
  const client = new QueryClient({
    // gcTime: 0 stops cache GC timers from keeping the Jest worker alive.
    defaultOptions: { mutations: { retry: false, gcTime: 0 } },
  });
  const invalidate = jest.spyOn(client, "invalidateQueries");
  const wrapper = ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client }, children);
  const { result } = renderHook(hook, { wrapper });
  return { result, invalidate };
}

beforeEach(() => {
  mockRpc.mockReset();
  showToast.mockReset();
});

describe("useCutLot", () => {
  it("cuts part of a batch with its date and refreshes the inventory", async () => {
    mockRpc.mockResolvedValue({ error: null });
    const { result, invalidate } = setup(useCutLot);

    act(() =>
      result.current.mutate({
        lot: { id: "lot-1", name: "Apple" },
        quantity: 1,
        expirationDate: "2030-01-03",
      }),
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockRpc).toHaveBeenCalledWith("cut_lot", {
      p_household_id: "household-1",
      p_lot_id: "lot-1",
      p_quantity: 1,
      p_expiration_date: "2030-01-03",
    });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["inventory"] });
  });

  it.each(["LOT_NOT_LIVE", "NOT_ENOUGH_LEFT"])(
    "says another phone changed the batch when the database answers %s",
    async (code) => {
      mockRpc.mockResolvedValue({ error: { message: code } });
      const { result, invalidate } = setup(useCutLot);

      act(() =>
        result.current.mutate({ lot: { id: "lot-1", name: "Apple" }, quantity: 2, expirationDate: null }),
      );

      await waitFor(() => expect(result.current.isError).toBe(true));
      expect(showToast).toHaveBeenCalledWith(
        expect.objectContaining({ type: "error", text1: "Apple already changed" }),
      );
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ["inventory"] });
    },
  );
});
