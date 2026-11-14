import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import Toast from "react-native-toast-message";
import type { InventoryItem } from "@/hooks/useInventoryItems";
import { dateInDays } from "@/lib/expiry";

const mockRpc = jest.fn();

jest.mock("@/lib/supabase", () => ({
  supabase: { rpc: (...args: unknown[]) => mockRpc(...args) },
}));
jest.mock("@/stores/auth", () => ({
  useAuthStore: (selector: (s: { householdId: string }) => unknown) =>
    selector({ householdId: "household-1" }),
}));
jest.mock("react-native-toast-message", () => ({ __esModule: true, default: { show: jest.fn() } }));

import CutLotControl from "@/components/CutLotControl";

const onCut = jest.fn();

function apples(overrides: Partial<InventoryItem> = {}): InventoryItem {
  return {
    id: "lot-1",
    food_id: "food-1",
    name: "Apple",
    quantity: 5,
    initial_quantity: 5,
    is_estimate: false,
    unit: "apple",
    whole_units_only: true,
    expiration_date: dateInDays(10),
    storage_location: "pantry",
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

function renderControl(lot: InventoryItem) {
  const client = new QueryClient({
    defaultOptions: { queries: { gcTime: 0 }, mutations: { retry: false, gcTime: 0 } },
  });
  render(
    <QueryClientProvider client={client}>
      <CutLotControl lot={lot} onCut={onCut} />
    </QueryClientProvider>,
  );
  fireEvent.press(screen.getByRole("button", { name: "Cut up or open part" }));
}

beforeEach(() => {
  mockRpc.mockReset();
  mockRpc.mockResolvedValue({ error: null });
  onCut.mockReset();
  (Toast.show as jest.Mock).mockReset();
});

it("starts collapsed and expands in place", () => {
  const client = new QueryClient();
  render(
    <QueryClientProvider client={client}>
      <CutLotControl lot={apples()} onCut={onCut} />
    </QueryClientProvider>,
  );
  const toggle = screen.getByRole("button", { name: "Cut up or open part" });

  expect(toggle.props.accessibilityState).toMatchObject({ expanded: false });
  expect(screen.queryByLabelText("Amount to cut up, in apple")).toBeNull();

  fireEvent.press(toggle);

  expect(screen.getByLabelText("Amount to cut up, in apple")).toBeTruthy();
  expect(screen.getByText("Use within")).toBeTruthy();
});

it("cuts the typed amount with a shorter date and reports it", async () => {
  renderControl(apples());

  fireEvent.changeText(screen.getByLabelText("Amount to cut up, in apple"), "1");
  fireEvent.press(screen.getByText("3 days"));
  fireEvent.press(screen.getByRole("button", { name: "Cut up" }));

  await waitFor(() => expect(onCut).toHaveBeenCalled());
  expect(mockRpc).toHaveBeenCalledWith("cut_lot", {
    p_household_id: "household-1",
    p_lot_id: "lot-1",
    p_quantity: 1,
    p_expiration_date: dateInDays(3),
  });
  expect(Toast.show).toHaveBeenCalledWith(
    expect.objectContaining({ type: "success", text1: "Cut up 1 apple of Apple" }),
  );
});

it("keeps the batch's date unless a shorter one is picked", async () => {
  renderControl(apples());

  fireEvent.changeText(screen.getByLabelText("Amount to cut up, in apple"), "2");
  fireEvent.press(screen.getByRole("button", { name: "Cut up" }));

  await waitFor(() => expect(onCut).toHaveBeenCalled());
  expect(mockRpc.mock.calls[0][1]).toMatchObject({ p_quantity: 2, p_expiration_date: null });
});

it("offers only dates sooner than the batch's", () => {
  renderControl(apples({ expiration_date: dateInDays(2) }));

  expect(screen.getByText("Same date")).toBeTruthy();
  expect(screen.getByText("1 day")).toBeTruthy();
  expect(screen.queryByText("3 days")).toBeNull();
});

it("offers no date for an undated batch", () => {
  renderControl(apples({ expiration_date: null }));

  expect(screen.getByText("No date")).toBeTruthy();
  expect(screen.getByText("5 days")).toBeTruthy();
});

it.each([
  ["more than the batch holds", "6"],
  ["a fraction of a whole-units food", "1.5"],
  ["nothing", "0"],
])("does not cut %s", (_, typed) => {
  renderControl(apples());

  fireEvent.changeText(screen.getByLabelText("Amount to cut up, in apple"), typed);
  fireEvent.press(screen.getByRole("button", { name: "Cut up" }));

  expect(mockRpc).not.toHaveBeenCalled();
});

it("cuts part of a measured batch by weight or volume", async () => {
  renderControl(
    apples({ name: "Juice", unit: "ml", quantity: 1000, whole_units_only: false }),
  );

  fireEvent.changeText(screen.getByLabelText("Amount to cut up, in ml"), "250,5");
  fireEvent.press(screen.getByRole("button", { name: "Cut up" }));

  await waitFor(() => expect(onCut).toHaveBeenCalled());
  expect(mockRpc.mock.calls[0][1]).toMatchObject({ p_quantity: 250.5 });
});

it("says the batch was opened when the whole amount is cut", async () => {
  renderControl(apples());

  fireEvent.changeText(screen.getByLabelText("Amount to cut up, in apple"), "5");
  fireEvent.press(screen.getByRole("button", { name: "Cut up" }));

  await waitFor(() => expect(onCut).toHaveBeenCalled());
  expect(Toast.show).toHaveBeenCalledWith(
    expect.objectContaining({ type: "success", text1: "Opened Apple" }),
  );
});
