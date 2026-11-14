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

import { useCombineLots } from "@/hooks/useCombineLots";

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

describe("useCombineLots", () => {
  it("pours the batches into the container batch and refreshes the inventory", async () => {
    mockRpc.mockResolvedValue({ error: null });
    const { result, invalidate } = setup(useCombineLots);

    act(() => result.current.mutate({ name: "Eggs", intoLotId: "lot-tray", lotIds: ["lot-carton", "lot-loose"] }));

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockRpc).toHaveBeenCalledWith("combine_lots", {
      p_household_id: "household-1",
      p_into_lot_id: "lot-tray",
      p_lot_ids: ["lot-carton", "lot-loose"],
    });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["inventory"] });
  });

  it("blames the connection for a failure other than a changed batch", async () => {
    mockRpc.mockResolvedValue({ error: { message: "Failed to fetch" } });
    const { result } = setup(useCombineLots);

    act(() => result.current.mutate({ name: "Eggs", intoLotId: "a", lotIds: ["b"] }));

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(showToast).toHaveBeenCalledWith(
      expect.objectContaining({ type: "error", text1: "Couldn't update Eggs" }),
    );
  });
});
