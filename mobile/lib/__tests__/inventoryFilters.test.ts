import type { InventoryItem } from "@/hooks/useInventoryItems";
import {
  countActiveFilters,
  describeFilters,
  EMPTY_FILTERS,
  filterInventory,
  filterOptions,
} from "@/lib/inventoryFilters";

const TODAY = new Date(2026, 10, 8, 12);

function inDays(n: number): string {
  const d = new Date(TODAY);
  d.setDate(d.getDate() + n);
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

const dairy = { id: "cat-dairy", name: "Dairy", icon: "tint" };
const meals = { id: "cat-meals", name: "Meals", icon: "cutlery" };

function lot(
  overrides: Partial<InventoryItem> &
    Pick<InventoryItem, "id" | "food_id" | "name">,
): InventoryItem {
  return {
    quantity: 1,
    unit: "each",
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
    category: null,
    ...overrides,
  };
}

const milkFridge = lot({
  id: "m1",
  food_id: "milk",
  name: "Milk",
  category: dairy,
  expiration_date: inDays(3),
});
const milkFreezer = lot({
  id: "m2",
  food_id: "milk",
  name: "Milk",
  category: dairy,
  storage_location: "freezer",
  expiration_date: inDays(40),
});
const chili = lot({
  id: "c1",
  food_id: "chili",
  name: "Chili",
  category: meals,
  is_leftover: true,
  expiration_date: inDays(2),
});
const salt = lot({
  id: "s1",
  food_id: "salt",
  name: "Salt",
  storage_location: "pantry",
});
const lots = [milkFridge, milkFreezer, chili, salt];

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(TODAY);
});

afterEach(() => {
  jest.useRealTimers();
});

describe("filterInventory", () => {
  it("keeps every lot with no search and no filters", () => {
    expect(filterInventory(lots, "", EMPTY_FILTERS)).toEqual(lots);
  });

  it("matches the search anywhere in the name, ignoring case and outer spaces", () => {
    expect(filterInventory(lots, "  ILK ", EMPTY_FILTERS)).toEqual([
      milkFridge,
      milkFreezer,
    ]);
  });

  it("keeps lots in any chosen place and any chosen category", () => {
    const filters = {
      ...EMPTY_FILTERS,
      locations: ["fridge" as const, "pantry" as const],
    };
    expect(filterInventory(lots, "", filters)).toEqual([
      milkFridge,
      chili,
      salt,
    ]);
    expect(
      filterInventory(lots, "", {
        ...EMPTY_FILTERS,
        categories: ["cat-meals", "uncategorized"],
      }),
    ).toEqual([chili, salt]);
  });

  it("keeps dated lots due within six days, and leftovers, when those switches are on", () => {
    expect(
      filterInventory(lots, "", { ...EMPTY_FILTERS, expiringWeek: true }),
    ).toEqual([milkFridge, chili]);
    expect(
      filterInventory(lots, "", { ...EMPTY_FILTERS, leftoversOnly: true }),
    ).toEqual([chili]);
  });
});

describe("filterOptions", () => {
  it("offers every place and the categories in stock, counting foods", () => {
    expect(filterOptions(lots)).toEqual({
      locations: [
        { value: "fridge", label: "Fridge", count: 2 },
        { value: "freezer", label: "Freezer", count: 1 },
        { value: "pantry", label: "Pantry", count: 1 },
      ],
      categories: [
        { value: "cat-meals", label: "Meals", count: 1 },
        { value: "cat-dairy", label: "Dairy", count: 1 },
        { value: "uncategorized", label: "Uncategorized", count: 1 },
      ],
    });
  });
});

describe("describeFilters", () => {
  const options = filterOptions(lots);

  it("counts each chosen value and switch", () => {
    expect(countActiveFilters(EMPTY_FILTERS)).toBe(0);
    expect(
      countActiveFilters({
        locations: ["fridge"],
        categories: ["a", "b"],
        expiringWeek: true,
        leftoversOnly: false,
      }),
    ).toBe(4);
  });

  it("names places, one category by name, several by count, then the switches", () => {
    expect(
      describeFilters(
        {
          locations: ["fridge", "pantry"],
          categories: ["cat-dairy"],
          expiringWeek: true,
          leftoversOnly: true,
        },
        options,
      ),
    ).toEqual([
      "Fridge",
      "Pantry",
      "Dairy",
      "Expiring this week",
      "Leftovers only",
    ]);
    expect(
      describeFilters(
        { ...EMPTY_FILTERS, categories: ["cat-dairy", "cat-meals"] },
        options,
      ),
    ).toEqual(["2 categories"]);
  });
});
