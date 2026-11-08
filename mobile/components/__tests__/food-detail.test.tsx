import React from "react";
import { fireEvent, render, screen, within } from "@testing-library/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const mockLots = { current: [] as unknown[] };
const mockError = { current: null as { message: string } | null };

jest.mock("@/lib/supabase", () => ({
  supabase: {
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
const mockParams = { current: { id: "food-milk" } };
jest.mock("expo-router", () => ({
  Stack: { Screen: () => null },
  useRouter: () => ({ push: mockPush, back: jest.fn() }),
  useLocalSearchParams: () => mockParams.current,
}));
jest.mock("@expo/vector-icons/FontAwesome", () => () => null);

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
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(
    <QueryClientProvider client={client}>
      <FoodDetailScreen />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mockPush.mockClear();
  mockParams.current = { id: "food-milk" };
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

  const cards = screen.getAllByRole("button");
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
