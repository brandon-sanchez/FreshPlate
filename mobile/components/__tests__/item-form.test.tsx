import React from "react";
import { View } from "react-native";
import { fireEvent, render, screen } from "@testing-library/react-native";
import type { FoodCategory } from "@/hooks/useFoodCategories";
import type { KnownFood } from "@/lib/knownFood";

jest.mock("@expo/vector-icons/FontAwesome", () => {
  const MockIcon = () => null;
  return MockIcon;
});

jest.mock("@/lib/supabase", () => ({ supabase: {} }));

const mockFoods: { current: KnownFood[] } = { current: [] };
jest.mock("@/hooks/useHouseholdFoods", () => ({
  useHouseholdFoods: () => ({ data: mockFoods.current }),
}));

import ItemForm, { ItemFormDefaults } from "@/components/ItemForm";

const category = (
  id: string,
  name: string,
  days: [number | null, number | null, number | null],
): FoodCategory => ({
  id,
  name,
  default_shelf_life_days: null,
  icon: null,
  fridge_days: days[0],
  freezer_days: days[1],
  pantry_days: days[2],
});

const categories = [
  category("cat-dairy", "Dairy & Eggs", [7, 90, null]),
  category("cat-bev", "Beverages", [10, null, 180]),
  category("cat-left", "Leftovers", [4, 60, null]),
];

const milk: KnownFood = {
  id: "food-milk",
  name: "Milk",
  nameKey: "milk",
  categoryId: "cat-dairy",
  stock: { base: "ml" },
  lastLot: {
    storage: "freezer",
    shelfLifeDays: 5,
    initialQuantity: 1000,
    package: { label: "bottle", size: 1000 },
  },
  status: { kind: "live" },
};

const egg: KnownFood = {
  id: "food-egg",
  name: "Egg",
  nameKey: "egg",
  categoryId: "cat-dairy",
  stock: { base: "each", eachLabel: "each", sizeEach: null },
  lastLot: null,
  status: { kind: "live" },
};

function form(onSubmit: jest.Mock, defaults?: ItemFormDefaults, key = 0) {
  return (
    <View>
      <ItemForm
        key={key}
        categories={categories}
        defaults={defaults}
        submitLabel="Add to inventory"
        onSubmit={onSubmit}
      />
    </View>
  );
}

function renderForm(defaults?: ItemFormDefaults) {
  const onSubmit = jest.fn();
  render(form(onSubmit, defaults));
  return onSubmit;
}

const button = (name: string) => screen.getByRole("button", { name });
const submit = () => fireEvent.press(screen.getByText("Add to inventory"));

describe("ItemForm", () => {
  beforeEach(() => {
    mockFoods.current = [milk];
    jest.useFakeTimers({ now: new Date(2026, 10, 8, 12) });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("re-adds a suggested food with its last category, place, package and shelf life", () => {
    const onSubmit = renderForm();

    fireEvent.press(button("Milk"));
    submit();

    expect(onSubmit).toHaveBeenCalledWith({
      name: "Milk",
      category_id: "cat-dairy",
      amount: {
        stockBase: "ml",
        quantity: 1000,
        package: { label: "bottle", size: 1000 },
      },
      expiration_date: "2026-11-13",
      storage_location: "freezer",
    });
  });

  it("limits the units to the stock base of a food the name matches", () => {
    renderForm();

    fireEvent.changeText(screen.getByLabelText("Item name"), " milk");

    expect(screen.getByText("Milk is tracked in ml.")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Package", selected: true }),
    ).toBeTruthy();
    expect(screen.getByLabelText("Package size").props.value).toBe("1");
    expect(
      screen.getAllByRole("button", { name: "ml" }).length,
    ).toBeGreaterThan(0);
    for (const hidden of ["g", "kg", "each", "Just a container"]) {
      expect(screen.queryByRole("button", { name: hidden })).toBeNull();
    }
  });

  it("offers every unit for a new food", () => {
    renderForm();

    fireEvent.changeText(screen.getByLabelText("Item name"), "Soup");

    expect(screen.queryByText(/is tracked in/)).toBeNull();
    for (const shown of [
      "g",
      "kg",
      "ml",
      "l",
      "each",
      "Package",
      "Just a container",
    ]) {
      expect(button(shown)).toBeTruthy();
    }
  });

  it("adds just a container as a count of one container", () => {
    const onSubmit = renderForm();

    fireEvent.changeText(screen.getByLabelText("Item name"), "Soup");
    fireEvent.press(button("Leftovers"));
    fireEvent.press(button("Just a container"));
    submit();

    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Soup",
        amount: { stockBase: "each", eachLabel: "container", quantity: 1 },
      }),
    );
  });

  it("multiplies the package size by the number of packages", () => {
    const onSubmit = renderForm();

    fireEvent.changeText(screen.getByLabelText("Item name"), "Orange juice");
    fireEvent.press(button("Beverages"));
    fireEvent.press(button("Package"));
    fireEvent.press(button("carton"));
    fireEvent.changeText(screen.getByLabelText("Package size"), "1");
    fireEvent.press(button("Package size in l"));
    fireEvent.press(button("Increase count"));
    submit();

    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        amount: {
          stockBase: "ml",
          quantity: 2000,
          package: { label: "carton", size: 1000 },
        },
      }),
    );
  });

  it("blocks a scanned item until the guessed category is confirmed", () => {
    const onSubmit = renderForm({
      name: "Salted butter",
      categoryId: "cat-bev",
      storage: "fridge",
      amount: {
        kind: "package",
        label: "pack",
        count: 1,
        size: { amount: "250", unit: "g" },
      },
      confirmCategory: true,
    });

    expect(screen.getByText("From the barcode. Tap to confirm.")).toBeTruthy();
    submit();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByText("Confirm the category")).toBeTruthy();

    fireEvent.press(button("Dairy & Eggs"));
    submit();

    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        category_id: "cat-dairy",
        amount: {
          stockBase: "g",
          quantity: 250,
          package: { label: "pack", size: 250 },
        },
      }),
    );
  });

  it("fits a scanned amount to the known food the scanned name matches", () => {
    const onSubmit = renderForm({
      name: "Milk",
      categoryId: "cat-dairy",
      amount: {
        kind: "package",
        label: "pack",
        count: 1,
        size: { amount: "500", unit: "g" },
      },
      confirmCategory: true,
    });

    submit();

    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        amount: {
          stockBase: "ml",
          quantity: 1000,
          package: { label: "bottle", size: 1000 },
        },
      }),
    );
  });

  it("shows a known food's category for a scan and needs no confirmation", () => {
    const onSubmit = renderForm({
      name: "milk",
      categoryId: "cat-bev",
      amount: {
        kind: "package",
        label: "carton",
        count: 1,
        size: { amount: "1", unit: "l" },
      },
      confirmCategory: true,
    });

    expect(screen.queryByText("From the barcode. Tap to confirm.")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Dairy & Eggs", selected: true }),
    ).toBeTruthy();
    submit();

    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ category_id: "cat-dairy" }),
    );
  });

  it("gives the typed amount back when the name runs past a known food", () => {
    mockFoods.current = [egg];
    const onSubmit = renderForm();

    fireEvent.press(button("kg"));
    fireEvent.changeText(screen.getByLabelText("Amount"), "2");
    fireEvent.changeText(screen.getByLabelText("Item name"), "Egg");
    expect(screen.queryByLabelText("Amount")).toBeNull();

    fireEvent.changeText(screen.getByLabelText("Item name"), "Eggplant");
    fireEvent.press(button("Dairy & Eggs"));
    expect(screen.getByLabelText("Amount").props.value).toBe("2");
    submit();

    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Eggplant",
        amount: { stockBase: "g", quantity: 2000, package: null },
      }),
    );
  });

  it("starts from the defaults again when remounted after an add", () => {
    const onSubmit = jest.fn();
    const { rerender } = render(form(onSubmit));
    fireEvent.press(button("Milk"));
    expect(screen.getByLabelText("Package size").props.value).toBe("1");

    rerender(form(onSubmit, undefined, 1));

    expect(screen.getByLabelText("Item name").props.value).toBe("");
    expect(
      screen.getByRole("button", { name: "each", selected: true }),
    ).toBeTruthy();
    expect(screen.queryByLabelText("Package size")).toBeNull();
  });
});
