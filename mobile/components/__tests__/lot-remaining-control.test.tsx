import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { InventoryItem } from "@/hooks/useInventoryItems";

const mockRpc = jest.fn();

jest.mock("@/lib/supabase", () => ({
  supabase: { rpc: (...args: unknown[]) => mockRpc(...args) },
}));
jest.mock("@/stores/auth", () => ({
  useAuthStore: (selector: (s: { householdId: string }) => unknown) =>
    selector({ householdId: "household-1" }),
}));

import LotRemainingControl from "@/components/LotRemainingControl";

function lot(overrides: Partial<InventoryItem> = {}): InventoryItem {
  return {
    id: "lot-1",
    food_id: "food-1",
    name: "Milk",
    quantity: 1000,
    initial_quantity: 1000,
    is_estimate: false,
    unit: "ml",
    whole_units_only: false,
    expiration_date: null,
    storage_location: "fridge",
    is_leftover: false,
    notes: null,
    added_by: null,
    opened_at: null,
    created_at: "2026-11-01T12:00:00+00:00",
    updated_at: "2026-11-09T10:00:00.123456+00:00",
    category: null,
    ...overrides,
  };
}

function renderControl(item: InventoryItem) {
  const client = new QueryClient({
    defaultOptions: { queries: { gcTime: 0 }, mutations: { retry: false, gcTime: 0 } },
  });
  render(
    <QueryClientProvider client={client}>
      <LotRemainingControl lot={item} />
    </QueryClientProvider>,
  );
}

function lastRpcArgs() {
  return mockRpc.mock.calls.at(-1)?.[1];
}

beforeEach(() => {
  mockRpc.mockReset();
  mockRpc.mockResolvedValue({ error: null });
});

it("sets a batch with a known full size to a fraction of it in one tap", async () => {
  renderControl(lot());

  fireEvent.press(screen.getByText("1/2"));

  await waitFor(() => expect(mockRpc).toHaveBeenCalledTimes(1));
  expect(screen.getByText("How full")).toBeTruthy();
  expect(lastRpcArgs()).toMatchObject({ p_lot_id: "lot-1", p_fraction: 0.5, p_quantity: null });
});

it("does not resend the fill level the batch already has", () => {
  renderControl(lot({ quantity: 750, is_estimate: true }));

  fireEvent.press(screen.getByText("3/4"));

  expect(mockRpc).not.toHaveBeenCalled();
});

it("sets an exact amount in the food's unit", async () => {
  renderControl(lot());

  const input = screen.getByLabelText("Exact amount left, in ml");
  fireEvent.changeText(input, "320,5");
  fireEvent.press(screen.getByText("Set"));

  await waitFor(() => expect(input.props.value).toBe(""));
  expect(mockRpc).toHaveBeenCalledTimes(1);
  expect(lastRpcArgs()).toMatchObject({ p_fraction: null, p_quantity: 320.5 });
});

it("ignores taps while a set is still saving", async () => {
  let finish = () => {};
  mockRpc.mockReturnValue(new Promise((resolve) => (finish = () => resolve({ error: null }))));
  renderControl(lot());

  fireEvent.press(screen.getByText("1/2"));
  await waitFor(() => expect(mockRpc).toHaveBeenCalledTimes(1));
  fireEvent.press(screen.getByText("1/4"));
  finish();

  await waitFor(() => expect(mockRpc).toHaveBeenCalledTimes(1));
});

it("offers only an exact amount when the full size is unknown", async () => {
  renderControl(lot({ initial_quantity: null, quantity: 120 }));

  expect(screen.queryByText("Full")).toBeNull();
  expect(screen.getByText("Amount left")).toBeTruthy();
  expect(screen.getByText("Full size unknown, so enter how much is left.")).toBeTruthy();

  fireEvent.changeText(screen.getByLabelText("Exact amount left, in ml"), "60");
  fireEvent.press(screen.getByText("Set"));

  await waitFor(() => expect(lastRpcArgs()).toMatchObject({ p_quantity: 60 }));
});

it("counts a whole-units food exactly and refuses a fractional count", () => {
  renderControl(lot({ unit: "can", quantity: 3, initial_quantity: 6, whole_units_only: true }));

  expect(screen.queryByText("1/2")).toBeNull();
  fireEvent.changeText(screen.getByLabelText("Exact amount left, in can"), "1.5");
  fireEvent.press(screen.getByText("Set"));

  expect(mockRpc).not.toHaveBeenCalled();
});

it("does not send an amount that is not a positive number", () => {
  renderControl(lot());

  fireEvent.changeText(screen.getByLabelText("Exact amount left, in ml"), "0");
  fireEvent.press(screen.getByText("Set"));

  expect(mockRpc).not.toHaveBeenCalled();
});
