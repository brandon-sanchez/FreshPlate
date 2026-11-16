import React from "react";
import { fireEvent, render, screen } from "@testing-library/react-native";
import type { InventoryItem } from "@/hooks/useInventoryItems";
import { dateInDays } from "@/lib/expiry";
import type { KnownFood } from "@/lib/knownFood";

jest.mock("@/lib/supabase", () => ({ supabase: {} }));
jest.mock("@expo/vector-icons/FontAwesome", () => () => null);
jest.mock("@react-native-community/slider", () => () => null);

const mockHorchata: KnownFood = {
  id: "food-horchata",
  name: "Horchata",
  nameKey: "horchata",
  categoryId: null,
  stock: { base: "ml" },
  lastLot: null,
  status: { kind: "live" },
};
const mockFoodsQuery: { current: { data: KnownFood[] | undefined; isPending: boolean } } = {
  current: { data: [mockHorchata], isPending: false },
};
jest.mock("@/hooks/useHouseholdFoods", () => ({
  useHouseholdFoods: () => mockFoodsQuery.current,
}));

import ItemForm from "@/components/ItemForm";

const dairy = {
  id: "c-dairy",
  name: "Dairy",
  icon: "tint",
  fridge_days: 7,
  freezer_days: 90,
  pantry_days: null,
};

function lot(id: string, overrides: Partial<InventoryItem> = {}): InventoryItem {
  return {
    id,
    food_id: "food-horchata",
    name: "Horchata",
    quantity: 500,
    initial_quantity: 1000,
    is_estimate: false,
    unit: "ml",
    whole_units_only: false,
    expiration_date: null,
    storage_location: "fridge",
    is_leftover: false,
    notes: null,
    added_by: null,
    opened_at: "2026-11-05T08:00:00+00:00",
    created_at: "2026-11-01T12:00:00+00:00",
    updated_at: "2026-11-09T10:00:00.123456+00:00",
    category: null,
    ...overrides,
  };
}

const onSubmit = jest.fn();

function formFor(existingLots?: InventoryItem[]) {
  return (
    <ItemForm
      categories={[dairy] as never}
      existingLots={existingLots}
      submitLabel="Add to inventory"
      onSubmit={onSubmit}
    />
  );
}

function renderForm(existingLots?: InventoryItem[]) {
  const view = render(formFor(existingLots));
  fireEvent.changeText(screen.getByPlaceholderText("What are you adding?"), "  horchata ");
  return view;
}

beforeEach(() => {
  onSubmit.mockReset();
  mockFoodsQuery.current = { data: [mockHorchata], isPending: false };
});

it("holds the add until the household's foods load, so the unit comes from the food", () => {
  mockFoodsQuery.current = { data: undefined, isPending: true };
  const lots = [lot("lot-jug")];
  const { rerender } = renderForm(lots);
  fireEvent.press(screen.getByRole("button", { name: "500 ml · Fridge" }));

  fireEvent.press(screen.getByText("Loading…"));
  expect(onSubmit).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "Loading…" })).toBeDisabled();

  mockFoodsQuery.current = { data: [mockHorchata], isPending: false };
  rerender(formFor(lots));
  fireEvent.changeText(screen.getByLabelText("Amount"), "250");
  fireEvent.press(screen.getByText("Add to inventory"));

  expect(onSubmit).toHaveBeenCalledWith(
    expect.objectContaining({
      amount: { stockBase: "ml", quantity: 250, package: null },
      into_lot_id: "lot-jug",
    }),
  );
});

it("offers the typed food's opened batches as containers to add into", () => {
  renderForm([
    lot("lot-jug"),
    lot("lot-carton", { quantity: 1000, opened_at: null, storage_location: "pantry" }),
    lot("lot-milk", { food_id: "food-milk", name: "Milk" }),
  ]);

  expect(screen.getByText("Add to an open container")).toBeTruthy();
  expect(screen.getByRole("button", { name: "New batch" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "500 ml · Fridge" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "1000 ml · Pantry" })).toBeNull();
  expect(screen.queryByText(/Milk/)).toBeNull();
});

it("submits into the picked container in its unit, without needing a category", () => {
  renderForm([lot("lot-jug", { storage_location: "freezer" })]);

  fireEvent.press(screen.getByRole("button", { name: "500 ml · Freezer" }));
  fireEvent.changeText(screen.getByLabelText("Amount"), "250");
  fireEvent.press(screen.getByText("Add to inventory"));

  expect(onSubmit).toHaveBeenCalledWith(
    expect.objectContaining({
      name: "horchata",
      amount: { stockBase: "ml", quantity: 250, package: null },
      storage_location: "freezer",
      into_lot_id: "lot-jug",
    }),
  );
  expect(screen.queryByText("Storage")).toBeNull();
});

it("dates the food going in by the container's location", () => {
  renderForm([lot("lot-jug", { storage_location: "freezer" })]);
  fireEvent.press(screen.getByText("Dairy"));

  fireEvent.press(screen.getByRole("button", { name: "500 ml · Freezer" }));
  fireEvent.changeText(screen.getByLabelText("Amount"), "250");
  fireEvent.press(screen.getByText("Add to inventory"));

  expect(onSubmit.mock.calls[0][0].expiration_date).toBe(dateInDays(90));
});

it("adds a new batch by default", () => {
  renderForm([lot("lot-jug")]);

  fireEvent.press(screen.getByText("Dairy"));
  fireEvent.changeText(screen.getByLabelText("Amount"), "250");
  fireEvent.press(screen.getByText("Add to inventory"));

  expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ into_lot_id: null }));
});

it("drops a picked container when the name changes to another food", () => {
  renderForm([lot("lot-jug")]);
  fireEvent.press(screen.getByRole("button", { name: "500 ml · Fridge" }));

  fireEvent.changeText(screen.getByPlaceholderText("What are you adding?"), "Milk");
  fireEvent.press(screen.getByText("Dairy"));
  fireEvent.press(screen.getByText("Add to inventory"));

  expect(screen.queryByText("Add to an open container")).toBeNull();
  expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ into_lot_id: null }));
});

it("offers no containers when the screen passes no batches", () => {
  renderForm();

  expect(screen.queryByText("Add to an open container")).toBeNull();
});

it("offers no containers when every batch of the food is sealed", () => {
  renderForm([lot("lot-carton", { opened_at: null })]);

  expect(screen.queryByText("Add to an open container")).toBeNull();
});
