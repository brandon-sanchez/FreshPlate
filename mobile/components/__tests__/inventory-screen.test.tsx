import React from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SafeAreaProvider } from "react-native-safe-area-context";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { swipeOpen } from "@/test-utils/swipe";

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
jest.mock("@/hooks/useReducedMotion", () => ({ useReducedMotion: () => true }));
const mockFetchFoodImage = jest.fn((..._args: unknown[]) => new Promise(() => {}));
jest.mock("@/lib/image-api", () => ({
  fetchFoodImage: (...args: unknown[]) => mockFetchFoodImage(...args),
}));

import InventoryScreen from "@/app/(tabs)/inventory";
import PinnedSectionList from "@/components/PinnedSectionList";

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

async function chooseTab(name: string) {
  fireEvent.press(screen.getByRole("tab", { name }));
  for (let frame = 0; frame < 20; frame++) {
    await act(() => new Promise((resolve) => setTimeout(resolve, 16)));
  }
}

async function dragOpen(name: string, lotIds: string) {
  const row = screen.getAllByTestId("swipe-row").find((r) => within(r).queryByText(name))!;
  await swipeOpen(`lot-swipe:${lotIds}`);
  return row;
}

beforeEach(async () => {
  await AsyncStorage.clear();
  mockFetchFoodImage.mockClear();
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
  await chooseTab("Urgency");
  expect(screen.getAllByText("Milk")).toHaveLength(1);
  expect(screen.getByText("2000 ml · 2 batches · Fridge, Freezer")).toBeTruthy();
  expect(screen.getByText("6 egg · Fridge")).toBeTruthy();

  fireEvent.press(screen.getByLabelText("Milk, 2000 ml, 2 batches, expires in 3 days"));
  expect(mockPush).toHaveBeenCalledWith("/food/food-milk");
});

it("builds a row's swipe actions only once the row is dragged", async () => {
  renderScreen();
  await screen.findByText("2 items · 1 expired");
  expect(screen.queryByLabelText("Toss")).toBeNull();

  const eggsRow = await dragOpen("Eggs", "eggs-1");

  expect(within(eggsRow).getByLabelText("Toss")).toBeTruthy();
  expect(screen.getAllByLabelText("Toss")).toHaveLength(1);
});

it("records every batch a row stacks when its swipe action is tapped", async () => {
  renderScreen();
  await screen.findByText("2 items · 1 expired");
  await chooseTab("Category");
  const milkRow = await dragOpen("Milk", "milk-fridge,milk-freezer");

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
  const milkRow = await dragOpen("Milk", "milk-fridge");

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
  await chooseTab("Category");
  const milkRow = await dragOpen("Milk", "milk-fridge,milk-freezer");

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

it("splits a food across places in the Location view it opens on", async () => {
  renderScreen();
  await screen.findByText("2 items · 1 expired");

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

it("opens Review expired from the subtitle in any view, even when the expired batch sits behind a fresh one", async () => {
  mockLots.current = [
    lotRow("milk-old", milk, -2, "fridge", 500),
    lotRow("milk-new", milk, 4, "fridge", 1000),
  ];
  renderScreen();
  await screen.findByText("1 item · 1 expired");

  await chooseTab("Category");
  fireEvent.press(screen.getByLabelText("1 expired. Review expired batches"));

  expect(mockPush).toHaveBeenCalledWith("/review-expired");
});

it("opens Review expired from the Expired section header", async () => {
  renderScreen();
  await screen.findByText("2 items · 1 expired");
  await chooseTab("Urgency");

  fireEvent.press(screen.getByText("Review"));

  expect(mockPush).toHaveBeenCalledWith("/review-expired");
});

it("swipes away only the unexpired batches of a row, leaving the expired one for review", async () => {
  mockLots.current = [
    lotRow("milk-old", milk, -2, "fridge", 500),
    lotRow("milk-new", milk, 4, "fridge", 1000),
  ];
  renderScreen();
  await screen.findByText("1 item · 1 expired");
  const milkRow = await dragOpen("Milk", "milk-new");

  fireEvent.press(within(milkRow!).getByLabelText("Used up"));

  await waitFor(() =>
    expect(mockRpc).toHaveBeenCalledWith("deplete_lots", {
      p_household_id: "household-1",
      p_lot_ids: ["milk-new"],
      p_reason: "used",
    }),
  );
});

it("offers no review when nothing has expired", async () => {
  mockLots.current = [lotRow("milk-new", milk, 4, "fridge", 1000)];
  renderScreen();
  await screen.findByText("1 item · 0 expired");

  expect(screen.queryByText(/Review/)).toBeNull();
});

it("opens the collapsed Fresh section to show a just-added batch", async () => {
  const butter = { id: "food-butter", name: "Butter", stock_base: "g", each_label: null };
  mockLots.current = [...mockLots.current, lotRow("butter-1", butter, 30, "fridge", 250)];
  mockParams.current = { added: "butter-1" };
  await AsyncStorage.setItem("freshplate.inventory-view", JSON.stringify({ groupBy: "Urgency" }));
  renderScreen();

  expect(await screen.findByText("Butter")).toBeTruthy();
});

it("keeps Fresh collapsed when nothing was just added", async () => {
  const butter = { id: "food-butter", name: "Butter", stock_base: "g", each_label: null };
  mockLots.current = [...mockLots.current, lotRow("butter-1", butter, 30, "fridge", 250)];
  renderScreen();
  await screen.findByText("3 items · 1 expired");
  await chooseTab("Urgency");

  expect(screen.queryByText("Butter")).toBeNull();
});

const rowNames = () => screen.getAllByText(/^(Eggs|Milk)$/).map((node) => node.props.children);

it("opens on Location, with the tabs in Location, Category, Urgency order", async () => {
  renderScreen();
  await screen.findByText("2 items · 1 expired");

  expect(screen.getAllByRole("tab").map((tab) => tab.props.accessibilityLabel)).toEqual([
    "Location",
    "Category",
    "Urgency",
  ]);
  expect(screen.getByRole("tab", { name: "Location", selected: true })).toBeTruthy();
});

async function openMenu() {
  fireEvent.press(screen.getByRole("button", { name: "Sort and filter" }));
  await screen.findByRole("button", { name: "Done" });
}

it("sorts the rows inside each section from the menu, flipping the direction on a second tap", async () => {
  renderScreen();
  await screen.findByText("2 items · 1 expired");
  expect(rowNames()).toEqual(["Eggs", "Milk", "Milk"]);
  expect(screen.getByText("Expiry date, soonest first · all 2 items")).toBeTruthy();

  await openMenu();
  expect(screen.getByRole("radio", { name: "Expiry date", checked: true })).toBeTruthy();
  fireEvent.press(screen.getByRole("radio", { name: "Name" }));
  fireEvent.press(screen.getByRole("radio", { name: "Name" }));

  expect(rowNames()).toEqual(["Milk", "Eggs", "Milk"]);
  expect(screen.getByRole("radio", { name: "Name", checked: true })).toBeTruthy();
  expect(screen.getByText("Name, Z to A · all 2 items")).toBeTruthy();
  expect(screen.getAllByText(/^(Fridge|Freezer)$/).map((node) => node.props.children)).toEqual([
    "Fridge",
    "Freezer",
  ]);
});

it("reopens with the grouping and sort chosen last time", async () => {
  const first = renderScreen();
  await screen.findByText("2 items · 1 expired");
  await chooseTab("Category");
  await openMenu();
  fireEvent.press(screen.getByRole("radio", { name: "Amount" }));
  await waitFor(async () => expect(await AsyncStorage.getItem("freshplate.inventory-view")).toContain("amount-desc"));
  first.unmount();

  renderScreen();
  await screen.findByText("2 items · 1 expired");

  expect(screen.getByRole("tab", { name: "Category", selected: true })).toBeTruthy();
  expect(screen.getByText("Amount, most first · all 2 items")).toBeTruthy();
});

it("filters by place from the menu as each option is checked, and clears from the summary line", async () => {
  renderScreen();
  await screen.findByText("2 items · 1 expired");

  await openMenu();
  expect(screen.queryByRole("checkbox", { name: "Freezer" })).toBeNull();
  fireEvent.press(screen.getByRole("button", { name: "Location" }));
  fireEvent.press(screen.getByRole("checkbox", { name: "Freezer" }));

  expect(rowNames()).toEqual(["Milk"]);
  expect(screen.getByText("1000 ml · Freezer")).toBeTruthy();
  expect(screen.getByRole("checkbox", { name: "Freezer", checked: true })).toBeTruthy();
  expect(screen.getByText("Expiry date, soonest first · Freezer")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Sort and filter" }).props.accessibilityValue).toEqual({
    text: "1 filter on",
  });

  fireEvent.press(screen.getByRole("button", { name: "Done" }));
  expect(screen.queryByRole("checkbox", { name: "Freezer" })).toBeNull();
  expect(screen.getByRole("button", { name: "Sort and filter", expanded: false })).toBeTruthy();
  fireEvent.press(screen.getByRole("button", { name: "Clear filters" }));

  expect(rowNames()).toEqual(["Eggs", "Milk", "Milk"]);
  expect(screen.getByText("Expiry date, soonest first · all 2 items")).toBeTruthy();
});

it("says nothing matches when a switch leaves no rows, offering to clear the filters", async () => {
  renderScreen();
  await screen.findByText("2 items · 1 expired");

  await openMenu();
  fireEvent.press(screen.getByRole("switch", { name: "Leftovers only" }));

  expect(screen.getByRole("switch", { name: "Leftovers only", checked: true })).toBeTruthy();
  expect(screen.queryByText("Milk")).toBeNull();
  expect(screen.getByText("No matches.")).toBeTruthy();

  fireEvent.press(screen.getByRole("button", { name: "Done" }));
  expect(screen.queryByRole("switch")).toBeNull();
  fireEvent.press(screen.getByText("Clear filters"));
  expect(rowNames()).toEqual(["Eggs", "Milk", "Milk"]);
});

it("closes the menu when tapped outside, keeping the current sort", async () => {
  renderScreen();
  await screen.findByText("2 items · 1 expired");

  await openMenu();
  fireEvent(screen.getByLabelText("Close sort and filter", { includeHiddenElements: true }), "pressIn");

  expect(screen.queryByRole("radio")).toBeNull();
  expect(rowNames()).toEqual(["Eggs", "Milk", "Milk"]);
});

it("asks for a row's photo only once the row has been on screen", async () => {
  renderScreen();
  await screen.findByText("2 items · 1 expired");
  expect(mockFetchFoodImage).not.toHaveBeenCalled();

  const list = screen.UNSAFE_getByType(PinnedSectionList);
  const milkRow = list.props.sections
    .flatMap((section: { data: { foodId: string }[] }) => section.data)
    .find((row: { foodId: string }) => row.foodId === "food-milk");
  act(() =>
    list.props.onViewableItemsChanged({
      viewableItems: [{ item: milkRow, key: "milk", index: 0, isViewable: true }],
      changed: [],
    }),
  );

  await waitFor(() => expect(mockFetchFoodImage).toHaveBeenCalledTimes(1));
  expect(mockFetchFoodImage.mock.calls[0][0]).toBe("food-milk");
});

it("mounts only the first rows of a long inventory", async () => {
  mockLots.current = Array.from({ length: 60 }, (_, i) =>
    lotRow(`lot-${i}`, { ...milk, id: `food-${i}`, name: `Food ${i}` }, 5, "fridge", 100),
  );
  renderScreen();
  await screen.findByText("60 items · 0 expired");

  const shown = screen.getAllByText(/^Food \d+$/).length;
  expect(shown).toBeGreaterThan(0);
  expect(shown).toBeLessThan(60);
});

it("moves the tab at once and regroups the rows once the old ones fade out", async () => {
  renderScreen();
  await screen.findByText("2 items · 1 expired");

  fireEvent.press(screen.getByRole("tab", { name: "Urgency" }));

  expect(screen.getByRole("tab", { name: "Urgency", selected: true })).toBeTruthy();
  expect(screen.queryByText("This week")).toBeNull();
  expect(await screen.findByText("This week")).toBeTruthy();
});

it("never says nothing matches while the rows regroup", async () => {
  renderScreen();
  await screen.findByText("2 items · 1 expired");

  fireEvent.press(screen.getByRole("tab", { name: "Category" }));
  for (let frame = 0; frame < 20; frame++) {
    await act(() => new Promise((resolve) => setTimeout(resolve, 16)));
    expect(screen.queryByText(/No matches/)).toBeNull();
  }

  expect(screen.getByText("Dairy")).toBeTruthy();
});
