import React from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SafeAreaProvider } from "react-native-safe-area-context";

const mockLots = { current: [] as unknown[] };
const mockRpc = jest.fn();

jest.mock("@/lib/supabase", () => ({
  supabase: {
    rpc: (...args: unknown[]) => mockRpc(...args),
    from: (table: string) =>
      table === "lots"
        ? {
            select: () => ({
              eq: () => ({
                is: () => ({
                  order: () => Promise.resolve({ data: mockLots.current, error: null }),
                }),
              }),
            }),
          }
        : { select: () => Promise.resolve({ data: [], error: null }) },
  },
}));
jest.mock("@/stores/auth", () => ({
  useAuthStore: (selector: (s: { householdId: string }) => unknown) =>
    selector({ householdId: "household-1" }),
}));
const mockPush = jest.fn();
const mockParams = { current: {} as { added?: string } };
jest.mock("expo-router", () => ({
  useRouter: () => ({ push: mockPush, setParams: jest.fn() }),
  useLocalSearchParams: () => mockParams.current,
}));
jest.mock("@react-navigation/bottom-tabs", () => ({ useBottomTabBarHeight: () => 0 }));
jest.mock("@expo/vector-icons/FontAwesome", () => () => null);

import InventoryScreen from "@/app/(tabs)/inventory";

function inDays(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() + n);
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

const dairy = { id: "c-dairy", name: "Dairy", icon: "tint" };

type Food = { id: string; name: string; stock_base: string; each_label: string | null };

function lotRow(id: string, food: Food, days: number, storage_location: string, quantity: number) {
  return {
    id,
    quantity,
    expiration_date: inDays(days),
    storage_location,
    notes: null,
    added_by: null,
    food: { ...food, category: dairy },
  };
}

const milk = { id: "food-milk", name: "Milk", stock_base: "ml", each_label: null };
const eggs = { id: "food-eggs", name: "Eggs", stock_base: "each", each_label: "egg" };

function renderScreen() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { gcTime: 0 } },
  });
  return render(
    <SafeAreaProvider
      initialMetrics={{
        frame: { x: 0, y: 0, width: 390, height: 844 },
        insets: { top: 44, right: 0, bottom: 34, left: 0 },
      }}
    >
      <QueryClientProvider client={client}>
        <InventoryScreen />
      </QueryClientProvider>
    </SafeAreaProvider>,
  );
}

beforeEach(() => {
  mockPush.mockClear();
  mockRpc.mockReset();
  mockRpc.mockResolvedValue({ error: null });
  mockParams.current = {};
  mockLots.current = [
    lotRow("eggs-1", eggs, -1, "fridge", 6),
    lotRow("milk-fridge", milk, 3, "fridge", 1000),
    lotRow("milk-freezer", milk, 40, "freezer", 1000),
  ];
});

it("shows one row per food with its batches stacked, counting foods in the subtitle", async () => {
  renderScreen();

  expect(await screen.findByText("2 items · 1 expired")).toBeTruthy();
  expect(screen.getAllByText("Milk")).toHaveLength(1);
  expect(screen.getByText("2000 ml · 2 batches · Fridge, Freezer")).toBeTruthy();
  expect(screen.getByText("6 egg · Fridge")).toBeTruthy();

  fireEvent.press(screen.getByLabelText("Milk, 2000 ml, 2 batches, expires in 3 days"));
  expect(mockPush).toHaveBeenCalledWith("/food/food-milk");
});

it("records every batch a row stacks when its swipe action is tapped", async () => {
  renderScreen();
  await screen.findByText("2 items · 1 expired");
  const milkRow = screen.getAllByTestId("swipe-row").find((row) => within(row).queryByText("Milk"));

  fireEvent.press(within(milkRow!).getByLabelText("Toss"));

  await waitFor(() =>
    expect(mockRpc).toHaveBeenCalledWith("deplete_lots", {
      p_household_id: "household-1",
      p_lot_ids: ["milk-fridge", "milk-freezer"],
      p_reason: "tossed",
    }),
  );
});

it("records a row once when its actions are tapped again before the first record finishes", async () => {
  let finish: (result: { error: null }) => void = () => {};
  mockRpc.mockReturnValue(new Promise((resolve) => (finish = resolve)));
  renderScreen();
  await screen.findByText("2 items · 1 expired");
  const milkRow = screen.getAllByTestId("swipe-row").find((row) => within(row).queryByText("Milk"));

  fireEvent.press(within(milkRow!).getByLabelText("Used up"));
  fireEvent.press(within(milkRow!).getByLabelText("Used up"));
  fireEvent.press(within(milkRow!).getByLabelText("Toss"));
  await act(async () => finish({ error: null }));

  expect(mockRpc).toHaveBeenCalledTimes(1);
});

it("takes taps again after a record fails", async () => {
  mockRpc.mockResolvedValueOnce({ error: { message: "Failed to fetch" } });
  renderScreen();
  await screen.findByText("2 items · 1 expired");
  const milkRow = screen.getAllByTestId("swipe-row").find((row) => within(row).queryByText("Milk"));

  fireEvent.press(within(milkRow!).getByLabelText("Used up"));
  await waitFor(() => expect(mockRpc).toHaveBeenCalledTimes(1));
  await waitFor(() => {
    fireEvent.press(within(milkRow!).getByLabelText("Toss"));
    expect(mockRpc).toHaveBeenCalledTimes(2);
  });

  expect(mockRpc).toHaveBeenLastCalledWith("deplete_lots", {
    p_household_id: "household-1",
    p_lot_ids: ["milk-fridge", "milk-freezer"],
    p_reason: "tossed",
  });
});

it("narrows rows by search", async () => {
  renderScreen();
  await screen.findByText("2 items · 1 expired");

  fireEvent.changeText(screen.getByPlaceholderText("Search your fridge"), "egg");

  expect(screen.queryByText("Milk")).toBeNull();
  expect(screen.getByText("Eggs")).toBeTruthy();
});

it("splits a food across places in the Location view", async () => {
  renderScreen();
  await screen.findByText("2 items · 1 expired");

  fireEvent.press(screen.getByText("Location"));

  expect(screen.getAllByText("Milk")).toHaveLength(2);
  expect(screen.getByText("1000 ml · Fridge")).toBeTruthy();
  expect(screen.getByText("1000 ml · Freezer")).toBeTruthy();
  expect(screen.queryByText(/batches/)).toBeNull();
});

it("counts a food with an expired batch behind a fresh one as expired and says so on its row", async () => {
  mockLots.current = [
    lotRow("milk-old", milk, -2, "fridge", 500),
    lotRow("milk-new", milk, 4, "fridge", 1000),
  ];
  renderScreen();

  expect(await screen.findByText("1 item · 1 expired")).toBeTruthy();
  expect(screen.getByText("1000 ml · 2 batches · Fridge · 1 expired")).toBeTruthy();
  expect(screen.getByLabelText("Milk, 1000 ml, 2 batches, expires in 4 days, 1 expired")).toBeTruthy();
});

it("opens the collapsed Fresh section to show a just-added batch", async () => {
  const butter = { id: "food-butter", name: "Butter", stock_base: "g", each_label: null };
  mockLots.current = [...mockLots.current, lotRow("butter-1", butter, 30, "fridge", 250)];
  mockParams.current = { added: "butter-1" };
  renderScreen();

  expect(await screen.findByText("Butter")).toBeTruthy();
});

it("keeps Fresh collapsed when nothing was just added", async () => {
  const butter = { id: "food-butter", name: "Butter", stock_base: "g", each_label: null };
  mockLots.current = [...mockLots.current, lotRow("butter-1", butter, 30, "fridge", 250)];
  renderScreen();
  await screen.findByText("3 items · 1 expired");

  expect(screen.queryByText("Butter")).toBeNull();
});
