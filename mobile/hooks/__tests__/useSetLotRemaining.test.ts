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

import { useSetLotRemaining } from "@/hooks/useSetLotRemaining";

const showToast = Toast.show as jest.Mock;
const lot = { id: "lot-1", updated_at: "2026-11-09T10:00:00.123456+00:00", name: "Milk" };

function setup() {
  const client = new QueryClient({
    // gcTime: 0 stops cache GC timers from keeping the Jest worker alive.
    defaultOptions: { mutations: { retry: false, gcTime: 0 } },
  });
  const invalidate = jest.spyOn(client, "invalidateQueries");
  const wrapper = ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client }, children);
  const { result } = renderHook(() => useSetLotRemaining(), { wrapper });
  return { result, invalidate };
}

beforeEach(() => {
  mockRpc.mockReset();
  showToast.mockReset();
});

it("sets a fill level with the batch's last-read version and refreshes the inventory", async () => {
  mockRpc.mockResolvedValue({ error: null });
  const { result, invalidate } = setup();

  act(() => result.current.mutate({ lot, remaining: { fraction: 0.5 } }));

  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(mockRpc).toHaveBeenCalledWith("set_lot_remaining", {
    p_household_id: "household-1",
    p_lot_id: "lot-1",
    p_seen_updated_at: "2026-11-09T10:00:00.123456+00:00",
    p_fraction: 0.5,
    p_quantity: null,
  });
  expect(invalidate).toHaveBeenCalledWith({ queryKey: ["inventory"] });
  expect(showToast).not.toHaveBeenCalled();
});

it("sets an exact amount", async () => {
  mockRpc.mockResolvedValue({ error: null });
  const { result } = setup();

  act(() => result.current.mutate({ lot, remaining: { quantity: 320 } }));

  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(mockRpc).toHaveBeenCalledWith(
    "set_lot_remaining",
    expect.objectContaining({ p_fraction: null, p_quantity: 320 }),
  );
});

it.each(["STALE", "LOT_NOT_LIVE", "FULL_SIZE_UNKNOWN"])(
  "says another phone changed the batch when the database answers %s, and refreshes",
  async (code) => {
    mockRpc.mockResolvedValue({ error: { message: code } });
    const { result, invalidate } = setup();

    act(() => result.current.mutate({ lot, remaining: { fraction: 0.25 } }));

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(showToast).toHaveBeenCalledWith(
      expect.objectContaining({ type: "error", text1: "Milk already changed" }),
    );
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["inventory"] });
  },
);

it("blames the connection for any other failure", async () => {
  mockRpc.mockResolvedValue({ error: { message: "Failed to fetch" } });
  const { result } = setup();

  act(() => result.current.mutate({ lot, remaining: { fraction: 1 } }));

  await waitFor(() => expect(result.current.isError).toBe(true));
  expect(showToast).toHaveBeenCalledWith(
    expect.objectContaining({ type: "error", text1: "Couldn't update Milk" }),
  );
});
