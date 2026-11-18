import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  fireEvent,
  render as renderNative,
  userEvent,
  waitFor,
} from "@testing-library/react-native";
import type { InventoryItem } from "@/hooks/useInventoryItems";
import { stackLots } from "@/lib/foodRows";
import InventoryRow from "@/components/InventoryRow";

jest.mock("@expo/vector-icons/FontAwesome", () => () => null);
// On iOS, LotOutcomeSwipe's tap gesture keeps a gesture-handler RectButton
// inside it from firing onPress. This RectButton drops onPress the same way,
// so a row that relies on one fails to open.
jest.mock("react-native-gesture-handler", () => {
  const { View } = jest.requireActual("react-native");
  return {
    ...jest.requireActual("react-native-gesture-handler"),
    RectButton: ({ onPress, ...props }: { onPress?: () => void }) => <View {...props} />,
  };
});

jest.mock("@/lib/supabase", () => ({ supabase: {} }));
jest.mock("@/hooks/useReducedMotion", () => ({ useReducedMotion: () => true }));

const mockFetchFoodImage = jest.fn();
jest.mock("@/lib/image-api", () => ({
  fetchFoodImage: (...args: unknown[]) => mockFetchFoodImage(...args),
}));

function render(ui: React.ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  return renderNative(ui, {
    wrapper: ({ children }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  });
}

const TODAY = new Date(2026, 10, 8, 12);

function lot(overrides: Partial<InventoryItem>): InventoryItem {
  return {
    id: "lot-1",
    food_id: "food-1",
    name: "Spinach",
    quantity: 1,
    unit: "bag",
    expiration_date: null,
    storage_location: "fridge",
    is_leftover: false,
    notes: null,
    added_by: null,
    opened_at: null,
    created_at: "2026-11-01T12:00:00+00:00",
    updated_at: "2026-11-01T12:00:00.123456+00:00",
    initial_quantity: null,
    is_estimate: false,
    whole_units_only: false,
    category: { id: "c1", name: "Produce", icon: "leaf" },
    ...overrides,
  };
}

const milk = (id: string, expiration_date: string) =>
  lot({ id, food_id: "milk", name: "Milk", unit: "ml", quantity: 1000, expiration_date });

beforeEach(() => {
  mockFetchFoodImage.mockReset();
  mockFetchFoodImage.mockReturnValue(new Promise(() => {}));
  jest.useFakeTimers();
  jest.setSystemTime(TODAY);
});

afterEach(() => {
  jest.useRealTimers();
});

it("shows a single batch exactly as a plain item row", () => {
  const [row] = stackLots([lot({ expiration_date: "2026-11-11" })]);
  const screen = render(<InventoryRow row={row} photoEnabled />);

  expect(screen.getByText("Spinach")).toBeTruthy();
  expect(screen.getByText("1 bag · Fridge")).toBeTruthy();
  expect(screen.getByText("3 days")).toBeTruthy();
  expect(screen.getByLabelText("Spinach, 1 bag, expires in 3 days")).toBeTruthy();
});

it("keeps the leftover tag and fractional amounts on a single batch", () => {
  const [row] = stackLots([
    lot({ name: "Soup", quantity: 0.5, unit: "cup", storage_location: "freezer", is_leftover: true }),
  ]);
  const screen = render(<InventoryRow row={row} photoEnabled />);

  expect(screen.getByText("0.5 cups · Freezer · Leftover")).toBeTruthy();
  expect(screen.getByLabelText("Soup, 0.5 cups, no expiry date")).toBeTruthy();
});

it("stacks batches into one total with a batch count and the next expiry", () => {
  const [row] = stackLots([milk("late", "2026-11-15"), milk("early", "2026-11-10")]);
  const onPress = jest.fn();
  const screen = render(<InventoryRow row={row} photoEnabled onPress={onPress} />);

  expect(screen.getByText("2 l · 2 batches · Fridge")).toBeTruthy();
  expect(screen.getByText("2 days")).toBeTruthy();

  fireEvent.press(screen.getByLabelText("Milk, 2 l, 2 batches, expires in 2 days"));
  expect(onPress).toHaveBeenCalledWith(row);
});

it("reads a total as about when any batch's amount is an estimate", () => {
  const [row] = stackLots([
    milk("known", "2026-11-15"),
    { ...milk("eyeballed", "2026-11-10"), quantity: 500, is_estimate: true },
  ]);
  const screen = render(<InventoryRow row={row} photoEnabled />);

  expect(screen.getByText("about 1.5 l · 2 batches · Fridge")).toBeTruthy();
});

it("counts an expired batch hidden behind a fresh one, leaving it out of the total", () => {
  const [row] = stackLots([milk("old", "2026-11-05"), milk("new", "2026-11-12")]);
  const screen = render(<InventoryRow row={row} photoEnabled />);

  expect(screen.getByText("1 l · 2 batches · Fridge · 1 expired")).toBeTruthy();
  expect(screen.getByText("4 days")).toBeTruthy();
});

it("labels a row expired once every batch has expired", () => {
  const [row] = stackLots([milk("a", "2026-11-05"), milk("b", "2026-11-07")]);
  const screen = render(<InventoryRow row={row} photoEnabled />);

  expect(screen.getByText("2 l · 2 batches · Fridge")).toBeTruthy();
  expect(screen.getByText("Expired")).toBeTruthy();
});

it("opens on a tap without a gesture-handler button, which the swipe actions block on iOS", async () => {
  jest.useRealTimers();
  const [row] = stackLots([lot({})]);
  const onPress = jest.fn();
  const screen = render(<InventoryRow row={row} photoEnabled={false} onPress={onPress} />);

  await userEvent.press(screen.getByText("Spinach"));

  expect(onPress).toHaveBeenCalledWith(row);
});

it("is not announced as a button when it has no onPress", () => {
  const [row] = stackLots([lot({})]);
  const screen = render(<InventoryRow row={row} photoEnabled={false} />);

  expect(screen.queryByRole("button")).toBeNull();
});

it("shows the food's photo in place of its category icon", async () => {
  mockFetchFoodImage.mockResolvedValue({
    status: "ready",
    image_key: "ingredient:spinach",
    url: "https://storage.test/spinach.webp?token=1",
    expires_at: "2026-11-08T13:00:00Z",
    reason: null,
  });
  const [row] = stackLots([lot({})]);
  const screen = render(<InventoryRow row={row} photoEnabled />);

  await waitFor(() =>
    expect(screen.getByTestId("food-photo-image", { includeHiddenElements: true })).toBeTruthy(),
  );
  expect(mockFetchFoodImage.mock.calls[0][0]).toBe("food-1");
});

it("shows the category icon without asking for a photo while photos are off", () => {
  const [row] = stackLots([lot({})]);
  const screen = render(<InventoryRow row={row} photoEnabled={false} />);

  expect(mockFetchFoodImage).not.toHaveBeenCalled();
  expect(
    screen.getByTestId("food-photo-placeholder", { includeHiddenElements: true }),
  ).toBeTruthy();
});
