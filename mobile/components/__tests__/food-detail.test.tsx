import React from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const mockLots = { current: [] as unknown[] };
const mockError = { current: null as { message: string } | null };
const mockRpc = jest.fn();

jest.mock("@/lib/supabase", () => ({
  supabase: {
    rpc: (...args: unknown[]) => mockRpc(...args),
    from: () => ({
      select: () => ({
        eq: () => ({
          is: () => ({
            order: () =>
              Promise.resolve(
                mockError.current
                  ? { data: null, error: mockError.current }
                  : { data: mockLots.current, error: null },
              ),
          }),
        }),
      }),
    }),
  },
}));
jest.mock("@/stores/auth", () => ({
  useAuthStore: (selector: (s: { householdId: string }) => unknown) =>
    selector({ householdId: "household-1" }),
}));
const mockPush = jest.fn();
const mockBack = jest.fn();
const mockParams = { current: { id: "food-milk" } };
jest.mock("expo-router", () => ({
  Stack: { Screen: () => null },
  useRouter: () => ({ push: mockPush, back: mockBack }),
  useLocalSearchParams: () => mockParams.current,
}));
jest.mock("@expo/vector-icons/FontAwesome", () => () => null);
jest.mock("@expo/vector-icons/Feather", () => () => null);
const mockFocused = { current: true };
jest.mock("@react-navigation/native", () => ({
  ...jest.requireActual("@react-navigation/native"),
  useIsFocused: () => mockFocused.current,
}));

import FoodDetailScreen from "@/app/food/[id]";

function inDays(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() + n);
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

const milk = {
  id: "food-milk",
  name: "Milk",
  stock_base: "ml",
  each_label: null,
  category: { id: "c-dairy", name: "Dairy", icon: "tint" },
};

function lotRow(
  id: string,
  days: number,
  extra: { quantity?: number; storage_location?: string; opened_at?: string; notes?: string } = {},
) {
  return {
    id,
    quantity: 1000,
    expiration_date: inDays(days),
    storage_location: "fridge",
    notes: null,
    added_by: null,
    opened_at: null,
    created_at: "2026-11-01T12:00:00+00:00",
    ...extra,
    food: milk,
  };
}

function renderScreen() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { gcTime: 0 } },
  });
  const tree = () => (
    <QueryClientProvider client={client}>
      <FoodDetailScreen />
    </QueryClientProvider>
  );
  const { rerender } = render(tree());
  return { client, rerender: () => rerender(tree()) };
}

const SWIPE_ACTIONS = ["Used up", "Toss"];

/** Each swiped batch's card, in screen order, without its swipe actions. */
function batchCards() {
  return screen
    .getAllByTestId("swipe-row")
    .flatMap((row) =>
      within(row)
        .getAllByRole("button")
        .filter((b) => !SWIPE_ACTIONS.includes(b.props.accessibilityLabel)),
    );
}

beforeEach(() => {
  mockPush.mockClear();
  mockBack.mockClear();
  mockRpc.mockReset();
  mockRpc.mockResolvedValue({ error: null });
  mockParams.current = { id: "food-milk" };
  mockFocused.current = true;
  mockError.current = null;
  mockLots.current = [
    lotRow("milk-sealed", 2, { quantity: 1000 }),
    lotRow("milk-expired", -2, { quantity: 250, notes: "Smells off" }),
    lotRow("milk-opened", 6, {
      quantity: 500,
      storage_location: "freezer",
      opened_at: "2026-11-05T08:00:00+00:00",
    }),
  ];
});

it("lists the food's batches in the order cooking draws them, tagging the next one", async () => {
  renderScreen();

  expect(await screen.findByText("Milk")).toBeTruthy();
  expect(screen.getByText("Dairy · 1750 ml · 3 batches")).toBeTruthy();

  const cards = batchCards();
  expect(cards.map((card) => card.props.accessibilityLabel)).toEqual([
    "500 ml, Freezer, Opened, Expires in 6 days, use first",
    "1000 ml, Fridge, Expires in 2 days",
    "250 ml, Fridge, Expired 2 days ago",
  ]);
  expect(within(cards[0]).getByText("Use first")).toBeTruthy();
  expect(within(cards[0]).getByText("Freezer · Opened")).toBeTruthy();
  expect(within(cards[2]).getByText("Expired")).toBeTruthy();
  expect(within(cards[2]).getByText("Smells off")).toBeTruthy();
  expect(screen.getAllByText("Use first")).toHaveLength(1);
});

it("opens the batch editor for a tapped batch", async () => {
  renderScreen();

  fireEvent.press(await screen.findByLabelText("1000 ml, Fridge, Expires in 2 days"));

  expect(mockPush).toHaveBeenCalledWith("/item/milk-sealed");
});

it("records a swiped batch on its own", async () => {
  renderScreen();
  const card = await screen.findByLabelText("1000 ml, Fridge, Expires in 2 days");
  const row = screen.getAllByTestId("swipe-row").find((r) => within(r).queryByLabelText(card.props.accessibilityLabel));

  fireEvent.press(within(row!).getByLabelText("Used up"));

  await waitFor(() =>
    expect(mockRpc).toHaveBeenCalledWith("deplete_lots", {
      p_household_id: "household-1",
      p_lot_ids: ["milk-sealed"],
      p_reason: "used",
    }),
  );
});

it("goes back when the food's last batch goes away while open", async () => {
  mockLots.current = [lotRow("milk-last", 3)];
  const { client } = renderScreen();
  await screen.findByText("Milk");

  mockLots.current = [];
  await act(() => client.invalidateQueries({ queryKey: ["inventory"] }));

  await waitFor(() => expect(mockBack).toHaveBeenCalledTimes(1));
  expect(screen.queryByText("Item not found")).toBeNull();
});

it("waits until it is shown again to go back when its last batch goes away behind another screen", async () => {
  mockLots.current = [lotRow("milk-last", 3)];
  const { client, rerender } = renderScreen();
  await screen.findByText("Milk");

  mockFocused.current = false;
  mockLots.current = [];
  await act(() => client.invalidateQueries({ queryKey: ["inventory"] }));
  await waitFor(() => expect(screen.queryByText("Milk")).toBeNull());
  expect(mockBack).not.toHaveBeenCalled();

  mockFocused.current = true;
  rerender();

  await waitFor(() => expect(mockBack).toHaveBeenCalledTimes(1));
  expect(screen.queryByText("Item not found")).toBeNull();
});

it("shows no batch to use first when every batch has expired", async () => {
  mockLots.current = [lotRow("milk-old", -1)];
  renderScreen();

  expect(await screen.findByText("Expired 1 day ago")).toBeTruthy();
  expect(screen.queryByText("Use first")).toBeNull();
});

it("says the item is not found for an unknown food", async () => {
  mockParams.current = { id: "food-gone" };
  renderScreen();

  expect(await screen.findByText("Item not found")).toBeTruthy();
});

it("offers a retry when the inventory fails to load", async () => {
  mockError.current = { message: "network down" };
  renderScreen();

  expect(await screen.findByText("Something went wrong")).toBeTruthy();
  expect(screen.queryByText("Item not found")).toBeNull();
});

it("combines the picked batches into the one cooking draws first", async () => {
  renderScreen();

  fireEvent.press(await screen.findByRole("button", { name: "Combine" }));
  fireEvent.press(screen.getByLabelText("1000 ml, Fridge, Expires in 2 days"));
  fireEvent.press(screen.getByLabelText("500 ml, Freezer, Opened, Expires in 6 days, use first"));
  fireEvent.press(screen.getByRole("button", { name: "Combine 2 batches" }));

  await waitFor(() =>
    expect(mockRpc).toHaveBeenCalledWith("combine_lots", {
      p_household_id: "household-1",
      p_into_lot_id: "milk-opened",
      p_lot_ids: ["milk-sealed"],
    }),
  );
  expect(mockPush).not.toHaveBeenCalled();
  await waitFor(() => expect(screen.getByRole("button", { name: "Combine" })).toBeTruthy());
});

it("checks the picked batches and says which one holds the mix", async () => {
  renderScreen();

  fireEvent.press(await screen.findByRole("button", { name: "Combine" }));
  expect(screen.getByText("Pick 2 or more batches")).toBeTruthy();

  const sealed = screen.getByLabelText("1000 ml, Fridge, Expires in 2 days");
  fireEvent.press(sealed);
  fireEvent.press(screen.getByLabelText("500 ml, Freezer, Opened, Expires in 6 days, use first"));

  expect(sealed.props.accessibilityRole).toBe("checkbox");
  expect(sealed.props.accessibilityState).toEqual({ checked: true });
  const openedDay = new Date("2026-11-05T08:00:00+00:00").toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
  expect(screen.getByText(`Into the 500 ml opened ${openedDay}`)).toBeTruthy();
});

it("needs two picked batches to combine, and cancels without changes", async () => {
  renderScreen();

  fireEvent.press(await screen.findByRole("button", { name: "Combine" }));
  fireEvent.press(screen.getByLabelText("1000 ml, Fridge, Expires in 2 days"));
  fireEvent.press(screen.getByRole("button", { name: "Combine 1 batch" }));
  fireEvent.press(screen.getByRole("button", { name: "Cancel" }));

  expect(mockRpc).not.toHaveBeenCalled();
  expect(screen.getAllByTestId("swipe-row")).toHaveLength(3);
});

it("offers no combine for a food with one batch", async () => {
  mockLots.current = [lotRow("milk-last", 3)];
  renderScreen();

  await screen.findByText("Milk");

  expect(screen.queryByRole("button", { name: "Combine" })).toBeNull();
});
