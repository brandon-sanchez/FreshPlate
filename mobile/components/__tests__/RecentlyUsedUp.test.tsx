import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { StyleSheet } from "react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const mockRows = jest.fn();
const mockRpc = jest.fn();
const mockQuery = {
  select: () => mockQuery,
  eq: () => mockQuery,
  order: async () => ({ data: mockRows(), error: null }),
};

jest.mock("@expo/vector-icons/Feather", () => () => null);
jest.mock("@/lib/supabase", () => ({
  supabase: { from: () => mockQuery, rpc: (...args: unknown[]) => mockRpc(...args) },
}));
jest.mock("@/stores/auth", () => ({
  useAuthStore: (selector: (s: { householdId: string }) => unknown) =>
    selector({ householdId: "household-1" }),
}));
jest.mock("@/lib/toast", () => ({ __esModule: true, default: { show: jest.fn() } }));

import RecentlyUsedUp from "@/components/RecentlyUsedUp";

const NOW = new Date("2026-11-17T12:00:00");
const LAYOUT = { nativeEvent: { layout: { x: 0, y: 0, width: 390, height: 120 } } };

const eggs = {
  lot_id: "lot-eggs",
  food_id: "food-eggs",
  name: "Eggs",
  stock_base: "each",
  each_label: "egg",
  whole_units_only: true,
  depleted_at: new Date("2026-11-16T19:00:00").toISOString(),
};
const milk = {
  lot_id: "lot-milk",
  food_id: "food-milk",
  name: "Milk",
  stock_base: "ml",
  each_label: null,
  whole_units_only: false,
  depleted_at: new Date("2026-11-12T08:00:00").toISOString(),
};

function renderSection(props: Partial<React.ComponentProps<typeof RecentlyUsedUp>> = {}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false, gcTime: 0 } },
  });
  return render(
    <QueryClientProvider client={client}>
      <RecentlyUsedUp search="" onRestored={jest.fn()} {...props} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  jest.useFakeTimers({ now: NOW });
  jest.clearAllMocks();
  mockRows.mockReturnValue([eggs, milk]);
  mockRpc.mockResolvedValue({ error: null });
});

afterEach(() => {
  jest.useRealTimers();
});

it("starts collapsed with a count, and lists when each food ran out once opened", async () => {
  renderSection();

  const header = await screen.findByRole("button", { name: "Recently used up, 2 foods" });
  expect(screen.queryByText("Eggs")).toBeNull();

  fireEvent.press(header);

  expect(screen.getByText("Eggs")).toBeTruthy();
  expect(screen.getByText("Used up yesterday")).toBeTruthy();
  expect(screen.getByText("Milk")).toBeTruthy();
  expect(screen.getByText("Used up 5 days ago")).toBeTruthy();
});

it("restores a food with the amount typed and reports the restored batch", async () => {
  const onRestored = jest.fn();
  renderSection({ onRestored });
  fireEvent.press(await screen.findByRole("button", { name: "Recently used up, 2 foods" }));

  fireEvent.press(screen.getByRole("button", { name: "Restore Eggs" }));
  fireEvent.changeText(screen.getByLabelText("Amount of Eggs left, in egg"), "3");
  fireEvent.press(screen.getByRole("button", { name: "Confirm restoring Eggs" }));

  await waitFor(() => expect(onRestored).toHaveBeenCalledWith("lot-eggs"));
  expect(mockRpc).toHaveBeenCalledWith("restore_used_up_lot", {
    p_household_id: "household-1",
    p_lot_id: "lot-eggs",
    p_quantity: 3,
  });
});

it("refuses an amount the food can't hold, such as half an egg", async () => {
  renderSection();
  fireEvent.press(await screen.findByRole("button", { name: "Recently used up, 2 foods" }));
  fireEvent.press(screen.getByRole("button", { name: "Restore Eggs" }));

  fireEvent.changeText(screen.getByLabelText("Amount of Eggs left, in egg"), "1.5");
  fireEvent.press(screen.getByRole("button", { name: "Confirm restoring Eggs" }));

  expect(mockRpc).not.toHaveBeenCalled();
});

it("follows the inventory search", async () => {
  renderSection({ search: "mil" });

  fireEvent.press(await screen.findByRole("button", { name: "Recently used up, 1 food" }));

  expect(screen.getByText("Milk")).toBeTruthy();
  expect(screen.queryByText("Eggs")).toBeNull();
});

it("renders nothing when no food ran out recently", async () => {
  mockRows.mockReturnValue([]);
  const { toJSON } = renderSection();

  await waitFor(() => expect(toJSON()).toBeNull());
});

it("lines up with the inventory sections' side margin", async () => {
  renderSection();

  await screen.findByRole("button", { name: "Recently used up, 2 foods" });

  expect(StyleSheet.flatten(screen.getByTestId("recently-used-up").props.style)).toMatchObject({
    paddingHorizontal: 16,
  });
});

it("asks once to be scrolled into view when the section or a Restore form opens", async () => {
  const onExpand = jest.fn();
  renderSection({ onExpand });
  fireEvent.press(await screen.findByRole("button", { name: "Recently used up, 2 foods" }));

  fireEvent(screen.getByTestId("recently-used-up-list"), "layout", LAYOUT);
  fireEvent(screen.getByTestId("recently-used-up-list"), "layout", LAYOUT);
  expect(onExpand).toHaveBeenCalledTimes(1);

  fireEvent.press(screen.getByRole("button", { name: "Restore Eggs" }));
  fireEvent(screen.getByTestId("restore-form-lot-eggs"), "layout", LAYOUT);
  expect(onExpand).toHaveBeenCalledTimes(2);
});
