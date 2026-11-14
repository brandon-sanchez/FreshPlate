import React from "react";
import { fireEvent, render } from "@testing-library/react-native";
import type { InventoryItem } from "@/hooks/useInventoryItems";
import { stackLots } from "@/lib/foodRows";
import InventoryRow from "@/components/InventoryRow";

jest.mock("@expo/vector-icons/FontAwesome", () => () => null);

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
  jest.useFakeTimers();
  jest.setSystemTime(TODAY);
});

afterEach(() => {
  jest.useRealTimers();
});

it("shows a single batch exactly as a plain item row", () => {
  const [row] = stackLots([lot({ expiration_date: "2026-11-11" })]);
  const screen = render(<InventoryRow row={row} />);

  expect(screen.getByText("Spinach")).toBeTruthy();
  expect(screen.getByText("1 bag · Fridge")).toBeTruthy();
  expect(screen.getByText("3 days")).toBeTruthy();
  expect(screen.getByLabelText("Spinach, 1 bag, expires in 3 days")).toBeTruthy();
});

it("keeps the leftover tag and fractional amounts on a single batch", () => {
  const [row] = stackLots([
    lot({ name: "Soup", quantity: 0.5, unit: "cup", storage_location: "freezer", is_leftover: true }),
  ]);
  const screen = render(<InventoryRow row={row} />);

  expect(screen.getByText("0.5 cup · Freezer · Leftover")).toBeTruthy();
  expect(screen.getByLabelText("Soup, 0.5 cup, no expiry date")).toBeTruthy();
});

it("stacks batches into one total with a batch count and the next expiry", () => {
  const [row] = stackLots([milk("late", "2026-11-15"), milk("early", "2026-11-10")]);
  const onPress = jest.fn();
  const screen = render(<InventoryRow row={row} onPress={onPress} />);

  expect(screen.getByText("2000 ml · 2 batches · Fridge")).toBeTruthy();
  expect(screen.getByText("2 days")).toBeTruthy();

  fireEvent.press(screen.getByLabelText("Milk, 2000 ml, 2 batches, expires in 2 days"));
  expect(onPress).toHaveBeenCalledWith(row);
});

it("reads a total as about when any batch's amount is an estimate", () => {
  const [row] = stackLots([
    milk("known", "2026-11-15"),
    { ...milk("eyeballed", "2026-11-10"), quantity: 500, is_estimate: true },
  ]);
  const screen = render(<InventoryRow row={row} />);

  expect(screen.getByText("about 1500 ml · 2 batches · Fridge")).toBeTruthy();
});

it("counts an expired batch hidden behind a fresh one, leaving it out of the total", () => {
  const [row] = stackLots([milk("old", "2026-11-05"), milk("new", "2026-11-12")]);
  const screen = render(<InventoryRow row={row} />);

  expect(screen.getByText("1000 ml · 2 batches · Fridge · 1 expired")).toBeTruthy();
  expect(screen.getByText("4 days")).toBeTruthy();
});

it("labels a row expired once every batch has expired", () => {
  const [row] = stackLots([milk("a", "2026-11-05"), milk("b", "2026-11-07")]);
  const screen = render(<InventoryRow row={row} />);

  expect(screen.getByText("2000 ml · 2 batches · Fridge")).toBeTruthy();
  expect(screen.getByText("Expired")).toBeTruthy();
});
