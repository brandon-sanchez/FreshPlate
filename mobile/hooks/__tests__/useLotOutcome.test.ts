import React from "react";
import { act, renderHook, waitFor } from "@testing-library/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import Toast from "@/lib/toast";

const mockRpc = jest.fn();

jest.mock("@/lib/supabase", () => ({
  supabase: { rpc: (...args: unknown[]) => mockRpc(...args) },
}));
jest.mock("@/stores/auth", () => ({
  useAuthStore: (selector: (s: { householdId: string }) => unknown) =>
    selector({ householdId: "household-1" }),
}));
jest.mock("@/lib/toast", () => ({ __esModule: true, default: { show: jest.fn() } }));

import { useLotOutcome } from "@/hooks/useLotOutcome";

const showToast = Toast.show as jest.Mock;

function wrapper({ children }: { children: React.ReactNode }) {
  const client = new QueryClient({
    // gcTime: 0 stops cache GC timers from keeping the Jest worker alive.
    defaultOptions: { mutations: { retry: false, gcTime: 0 } },
  });
  return React.createElement(QueryClientProvider, { client }, children);
}

function lastToast() {
  return showToast.mock.calls.at(-1)?.[0];
}

beforeEach(() => {
  mockRpc.mockReset();
  showToast.mockReset();
});

it("records a used-up food and offers to undo it", async () => {
  mockRpc.mockResolvedValue({ error: null });
  const { result } = renderHook(() => useLotOutcome(), { wrapper });

  act(() => result.current.record({ lotIds: ["lot-1"], outcome: "used", name: "Milk" }, jest.fn()));

  await waitFor(() => expect(showToast).toHaveBeenCalled());
  expect(mockRpc).toHaveBeenCalledWith("deplete_lots", {
    p_household_id: "household-1",
    p_lot_ids: ["lot-1"],
    p_reason: "used",
  });
  expect(lastToast()).toMatchObject({ type: "undo", text1: "Milk used up", text2: undefined });
});

it("records every batch of a tossed food and undo restores the same batches", async () => {
  mockRpc.mockResolvedValue({ error: null });
  const { result } = renderHook(() => useLotOutcome(), { wrapper });

  act(() => result.current.record({ lotIds: ["a", "b"], outcome: "tossed", name: "Milk" }, jest.fn()));
  await waitFor(() => expect(showToast).toHaveBeenCalled());
  expect(mockRpc).toHaveBeenCalledWith("deplete_lots", {
    p_household_id: "household-1",
    p_lot_ids: ["a", "b"],
    p_reason: "tossed",
  });
  const toast = lastToast();
  expect(toast).toMatchObject({ type: "undo", text1: "Milk tossed", text2: "2 batches" });

  act(() => toast.props.onUndo());

  await waitFor(() => expect(lastToast()).toMatchObject({ type: "success", text1: "Restored" }));
  expect(mockRpc).toHaveBeenLastCalledWith("restore_lots", {
    p_household_id: "household-1",
    p_lot_ids: ["a", "b"],
  });
});

it("blames the connection and lets the caller react when recording fails", async () => {
  mockRpc.mockResolvedValue({ error: { message: "Failed to fetch" } });
  const onError = jest.fn();
  const { result } = renderHook(() => useLotOutcome(), { wrapper });

  act(() => result.current.record({ lotIds: ["lot-1"], outcome: "used", name: "Milk" }, onError));

  await waitFor(() => expect(onError).toHaveBeenCalled());
  expect(lastToast()).toMatchObject({
    type: "error",
    text1: "Couldn't update Milk",
    text2: "Check your connection and try again.",
  });
});

it("says another phone changed the food when its batches are no longer live", async () => {
  mockRpc.mockResolvedValue({ error: { message: "LOT_NOT_LIVE" } });
  const onError = jest.fn();
  const { result } = renderHook(() => useLotOutcome(), { wrapper });

  act(() => result.current.record({ lotIds: ["lot-1"], outcome: "used", name: "Milk" }, onError));

  await waitFor(() => expect(onError).toHaveBeenCalled());
  expect(lastToast()).toMatchObject({
    type: "error",
    text1: "Milk already changed",
    text2: "It was updated on another phone.",
  });
});

async function recordThenUndo(restoreError: { message: string }) {
  mockRpc.mockResolvedValueOnce({ error: null });
  mockRpc.mockResolvedValueOnce({ error: restoreError });
  const { result } = renderHook(() => useLotOutcome(), { wrapper });

  act(() => result.current.record({ lotIds: ["lot-1"], outcome: "tossed", name: "Milk" }, jest.fn()));
  await waitFor(() => expect(showToast).toHaveBeenCalled());
  act(() => lastToast().props.onUndo());
}

it("says the undo failed on a connection error", async () => {
  await recordThenUndo({ message: "Failed to fetch" });

  await waitFor(() =>
    expect(lastToast()).toMatchObject({
      type: "error",
      text1: "Couldn't undo",
      text2: "Check your connection and try again.",
    }),
  );
});

it("says the undo failed because another phone changed the batches", async () => {
  await recordThenUndo({ message: "LOT_NOT_RESTORABLE" });

  await waitFor(() =>
    expect(lastToast()).toMatchObject({
      type: "error",
      text1: "Couldn't undo",
      text2: "It was changed on another phone.",
    }),
  );
});

it("undoes once however many times Undo is tapped", async () => {
  mockRpc.mockResolvedValue({ error: null });
  const { result } = renderHook(() => useLotOutcome(), { wrapper });

  act(() => result.current.record({ lotIds: ["lot-1"], outcome: "used", name: "Milk" }, jest.fn()));
  await waitFor(() => expect(showToast).toHaveBeenCalled());
  const { onUndo } = lastToast().props;
  act(() => {
    onUndo();
    onUndo();
  });

  await waitFor(() => expect(lastToast()).toMatchObject({ type: "success", text1: "Restored" }));
  expect(mockRpc.mock.calls.filter(([fn]) => fn === "restore_lots")).toHaveLength(1);
});

it("still undoes after the row that recorded the batches is gone", async () => {
  mockRpc.mockResolvedValue({ error: null });
  const { result, unmount } = renderHook(() => useLotOutcome(), { wrapper });

  act(() => result.current.record({ lotIds: ["lot-1"], outcome: "used", name: "Milk" }, jest.fn()));
  await waitFor(() => expect(showToast).toHaveBeenCalled());
  const { onUndo } = lastToast().props;
  unmount();
  act(() => onUndo());

  await waitFor(() => expect(lastToast()).toMatchObject({ type: "success", text1: "Restored" }));
  expect(mockRpc).toHaveBeenLastCalledWith("restore_lots", {
    p_household_id: "household-1",
    p_lot_ids: ["lot-1"],
  });
});
