import React from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SafeAreaProvider } from "react-native-safe-area-context";

const mockLots = { current: [] as unknown[] };
const mockRpc = jest.fn();
const mockUpdate = jest.fn();

jest.mock("@/lib/supabase", () => ({
  supabase: {
    rpc: (...args: unknown[]) => mockRpc(...args),
    from: () => ({
      select: () => ({
        eq: () => ({
          is: () => ({
            order: () => Promise.resolve({ data: mockLots.current, error: null }),
          }),
        }),
      }),
      update: (patch: unknown) => ({
        eq: (_col: string, id: string) => ({
          is: () => ({ select: () => mockUpdate(id, patch) }),
        }),
      }),
    }),
  },
}));
jest.mock("@/stores/auth", () => ({
  useAuthStore: (selector: (s: { householdId: string }) => unknown) =>
    selector({ householdId: "household-1" }),
}));
const mockBack = jest.fn();
jest.mock("expo-router", () => ({
  Stack: { Screen: () => null },
  useRouter: () => ({ push: jest.fn(), back: mockBack }),
}));
jest.mock("@expo/vector-icons/FontAwesome", () => () => null);
const mockPickerChange = { current: (_date: Date) => {} };
jest.mock("@react-native-community/datetimepicker", () => {
  const { View } = jest.requireActual("react-native");
  return {
    __esModule: true,
    default: ({ onChange, testID }: { onChange: (e: unknown, d: Date) => void; testID: string }) => {
      mockPickerChange.current = (date: Date) => onChange({ type: "set" }, date);
      return <View testID={testID} />;
    },
    DateTimePickerAndroid: { open: jest.fn() },
  };
});
jest.mock("@react-navigation/native", () => ({
  ...jest.requireActual("@react-navigation/native"),
  useIsFocused: () => true,
}));

import { Alert } from "react-native";
import ReviewExpiredScreen from "@/app/review-expired";

const alertSpy = jest.spyOn(Alert, "alert").mockImplementation(() => {});

function inDays(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() + n);
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

type Food = {
  id: string;
  name: string;
  stock_base: string;
  each_label: string | null;
  whole_units_only: boolean;
  category: null;
};

const milk: Food = {
  id: "food-milk",
  name: "Milk",
  stock_base: "ml",
  each_label: null,
  whole_units_only: false,
  category: null,
};
const eggs: Food = {
  id: "food-eggs",
  name: "Eggs",
  stock_base: "each",
  each_label: "egg",
  whole_units_only: true,
  category: null,
};

function lotRow(id: string, food: Food, days: number, quantity: number) {
  return {
    id,
    quantity,
    initial_quantity: quantity,
    is_estimate: false,
    expiration_date: inDays(days),
    storage_location: "fridge",
    notes: null,
    added_by: null,
    opened_at: null,
    created_at: "2026-11-01T12:00:00+00:00",
    updated_at: "2026-11-01T12:00:00.123456+00:00",
    food,
  };
}

function renderScreen() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { gcTime: 0 } },
  });
  render(
    <SafeAreaProvider
      initialMetrics={{
        frame: { x: 0, y: 0, width: 390, height: 844 },
        insets: { top: 44, right: 0, bottom: 34, left: 0 },
      }}
    >
      <QueryClientProvider client={client}>
        <ReviewExpiredScreen />
      </QueryClientProvider>
    </SafeAreaProvider>,
  );
  return client;
}

function card(name: string) {
  const found = screen
    .getAllByTestId("expired-batch")
    .find((c) => within(c).queryByLabelText(new RegExp(`^${name}, `)));
  if (!found) throw new Error(`no expired batch of ${name}`);
  return found;
}

beforeEach(() => {
  alertSpy.mockClear();
  mockBack.mockClear();
  mockRpc.mockReset();
  mockRpc.mockResolvedValue({ error: null });
  mockUpdate.mockReset();
  mockUpdate.mockResolvedValue({ data: [{ id: "x" }], error: null });
  mockLots.current = [
    lotRow("milk-old", milk, -2, 500),
    lotRow("milk-fresh", milk, 4, 1000),
    lotRow("eggs-old", eggs, -9, 6),
  ];
});

it("lists only expired batches, most overdue first", async () => {
  renderScreen();

  expect(await screen.findByText("2 expired batches")).toBeTruthy();
  expect(screen.getAllByLabelText(/Expired \d+ days ago/).map((c) => c.props.accessibilityLabel)).toEqual([
    "Eggs, 6 egg, Expired 9 days ago",
    "Milk, 500 ml, Expired 2 days ago",
  ]);
});

it("tosses one batch, recording it as waste", async () => {
  renderScreen();
  await screen.findByText("2 expired batches");

  fireEvent.press(within(card("Milk")).getByText("Toss"));

  await waitFor(() =>
    expect(mockRpc).toHaveBeenCalledWith("deplete_lots", {
      p_household_id: "household-1",
      p_lot_ids: ["milk-old"],
      p_reason: "tossed",
    }),
  );
});

function answerAlert(text: string) {
  const buttons = alertSpy.mock.calls.at(-1)?.[2] ?? [];
  act(() => buttons.find((b) => b.text === text)?.onPress?.());
}

it("tosses every expired batch at once after confirming, and leaves the fresh ones", async () => {
  renderScreen();
  await screen.findByText("2 expired batches");

  fireEvent.press(screen.getByLabelText("Toss all"));
  expect(alertSpy.mock.calls[0][0]).toBe("Toss 2 batches?");
  answerAlert("Toss all");

  await waitFor(() =>
    expect(mockRpc).toHaveBeenCalledWith("deplete_lots", {
      p_household_id: "household-1",
      p_lot_ids: ["eggs-old", "milk-old"],
      p_reason: "tossed",
    }),
  );
});

it("tosses nothing when Toss all is cancelled", async () => {
  renderScreen();
  await screen.findByText("2 expired batches");

  fireEvent.press(screen.getByLabelText("Toss all"));
  answerAlert("Cancel");

  expect(mockRpc).not.toHaveBeenCalled();
});

it("keeps a batch that is still good with the date picked", async () => {
  renderScreen();
  await screen.findByText("2 expired batches");

  fireEvent.press(within(card("Milk")).getByText("Still good"));
  fireEvent.press(within(card("Milk")).getByText("1 week"));

  await waitFor(() =>
    expect(mockUpdate).toHaveBeenCalledWith("milk-old", { expiration_date: inDays(7) }),
  );
});

it("keeps a batch until an exact date picked from the calendar", async () => {
  renderScreen();
  await screen.findByText("2 expired batches");

  fireEvent.press(within(card("Milk")).getByText("Still good"));
  fireEvent.press(within(card("Milk")).getByText("Pick a date…"));
  const [y, m, d] = inDays(10).split("-").map(Number);
  act(() => mockPickerChange.current(new Date(y, m - 1, d, 15, 30)));
  fireEvent.press(within(card("Milk")).getByText(/^Keep until /));

  await waitFor(() =>
    expect(mockUpdate).toHaveBeenCalledWith("milk-old", { expiration_date: inDays(10) }),
  );
});

it("says nothing expired when opened with no expired batches", async () => {
  mockLots.current = [lotRow("milk-fresh", milk, 4, 1000)];
  renderScreen();

  expect(await screen.findByText("Nothing expired")).toBeTruthy();
  expect(screen.queryByLabelText("Toss all")).toBeNull();
  expect(mockBack).not.toHaveBeenCalled();
});

it("lets a Still good choice be cancelled", async () => {
  renderScreen();
  await screen.findByText("2 expired batches");

  fireEvent.press(within(card("Milk")).getByText("Still good"));
  fireEvent.press(within(card("Milk")).getByText("Cancel"));

  expect(within(card("Milk")).getByText("Toss")).toBeTruthy();
  expect(mockUpdate).not.toHaveBeenCalled();
});

it("goes back once nothing expired is left", async () => {
  const client = renderScreen();
  await screen.findByText("2 expired batches");

  mockLots.current = [lotRow("milk-fresh", milk, 4, 1000)];
  await act(() => client.invalidateQueries({ queryKey: ["inventory"] }));

  await waitFor(() => expect(mockBack).toHaveBeenCalledTimes(1));
});

it("takes taps again after a toss fails", async () => {
  mockRpc.mockResolvedValueOnce({ error: { message: "Network request failed" } });
  renderScreen();
  await screen.findByText("2 expired batches");

  fireEvent.press(within(card("Milk")).getByText("Toss"));
  await waitFor(() => expect(mockRpc).toHaveBeenCalledTimes(1));
  await act(async () => {});
  fireEvent.press(within(card("Milk")).getByText("Toss"));

  await waitFor(() => expect(mockRpc).toHaveBeenCalledTimes(2));
});

it("lets a failed batch be tossed again while another batch's toss goes through", async () => {
  mockRpc.mockResolvedValueOnce({ error: { message: "Network request failed" } });
  renderScreen();
  await screen.findByText("2 expired batches");

  fireEvent.press(within(card("Milk")).getByText("Toss"));
  fireEvent.press(within(card("Eggs")).getByText("Toss"));
  await waitFor(() => expect(mockRpc).toHaveBeenCalledTimes(2));
  await act(async () => {});
  fireEvent.press(within(card("Milk")).getByText("Toss"));

  await waitFor(() => expect(mockRpc).toHaveBeenCalledTimes(3));
  expect(mockRpc).toHaveBeenLastCalledWith("deplete_lots", {
    p_household_id: "household-1",
    p_lot_ids: ["milk-old"],
    p_reason: "tossed",
  });
});

it("takes no taps on a batch while Toss all runs", async () => {
  let finish: (value: { error: null }) => void = () => {};
  mockRpc.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));
  renderScreen();
  await screen.findByText("2 expired batches");

  fireEvent.press(screen.getByLabelText("Toss all"));
  answerAlert("Toss all");
  await waitFor(() => expect(mockRpc).toHaveBeenCalledTimes(1));
  fireEvent.press(within(card("Milk")).getByText("Toss"));
  await act(async () => {});

  expect(mockRpc).toHaveBeenCalledTimes(1);
  await act(async () => finish({ error: null }));
});
