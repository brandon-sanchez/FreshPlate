import type { InventoryItem } from "@/hooks/useInventoryItems";
import { groupFoodRows, type FoodSection, type GroupBy } from "@/lib/foodRows";
import { sortSections, type SortBy } from "@/lib/foodSort";

const TODAY = new Date(2026, 10, 8, 12);

function inDays(n: number): string {
  const d = new Date(TODAY);
  d.setDate(d.getDate() + n);
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

const dairy = { id: "cat-dairy", name: "Dairy", icon: "tint" };
const produce = { id: "cat-produce", name: "Produce", icon: "leaf" };

function lot(overrides: Partial<InventoryItem> & Pick<InventoryItem, "id" | "food_id" | "name">): InventoryItem {
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

function section(sections: FoodSection[], key: string): FoodSection {
  const found = sections.find((s) => s.key === key);
  if (!found) throw new Error(`no section ${key}`);
  return found;
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(TODAY);
});

afterEach(() => {
  jest.useRealTimers();
});

const sorted = (lots: InventoryItem[], groupBy: GroupBy, sortBy: SortBy) =>
  sortSections(groupFoodRows(lots, groupBy), sortBy);

describe("sortSections", () => {
  const food = (name: string, unit: string, quantity: number, days: number | null, addedOn: string) =>
    lot({
      id: name.toLowerCase(),
      food_id: name.toLowerCase(),
      name,
      unit,
      quantity,
      category: dairy,
      expiration_date: days === null ? null : inDays(days),
      created_at: `2026-11-0${addedOn}T12:00:00+00:00`,
    });
  const kitchen = () => [
    food("Butter", "g", 250, 20, "3"),
    food("Milk", "ml", 2000, 9, "1"),
    food("Cream", "ml", 500, 14, "5"),
    food("Eggs", "egg", 12, 30, "2"),
    food("Cheese", "g", 400, null, "4"),
  ];
  const onlySection = { Location: "fridge", Category: "cat-dairy", Urgency: "fresh" } as const;
  const groupings = Object.keys(onlySection) as (keyof typeof onlySection)[];

  const expected: [SortBy, string[]][] = [
    ["expiry-soonest", ["Milk", "Cream", "Butter", "Eggs", "Cheese"]],
    ["expiry-latest", ["Eggs", "Butter", "Cream", "Milk", "Cheese"]],
    ["name-asc", ["Butter", "Cheese", "Cream", "Eggs", "Milk"]],
    ["name-desc", ["Milk", "Eggs", "Cream", "Cheese", "Butter"]],
    ["amount-desc", ["Cheese", "Butter", "Milk", "Cream", "Eggs"]],
    ["amount-asc", ["Butter", "Cheese", "Cream", "Milk", "Eggs"]],
    ["recent", ["Cream", "Cheese", "Butter", "Eggs", "Milk"]],
  ];

  describe.each(groupings)("in the %s view", (groupBy) => {
    it.each(expected)("orders rows by %s", (sortBy, names) => {
      const rows = section(sorted(kitchen(), groupBy, sortBy), onlySection[groupBy]).data;

      expect(rows.map((r) => r.name)).toEqual(names);
    });
  });

  it.each(["Location", "Category"] as const)(
    "puts expired rows first under soonest first in the %s view",
    (groupBy) => {
      const sour = food("Yogurt", "g", 500, -2, "6");
      const sections = sorted([...kitchen(), sour], groupBy, "expiry-soonest");

      expect(section(sections, onlySection[groupBy]).data.map((r) => r.name)).toEqual([
        "Yogurt",
        "Milk",
        "Cream",
        "Butter",
        "Eggs",
        "Cheese",
      ]);
    },
  );

  it("orders a food's row by the batches in that section only", () => {
    const frozenMilk = lot({
      id: "milk-frozen",
      food_id: "milk",
      name: "Milk",
      unit: "ml",
      quantity: 5000,
      storage_location: "freezer",
      expiration_date: inDays(90),
      created_at: "2026-11-09T12:00:00+00:00",
    });
    const sections = sorted([...kitchen(), frozenMilk], "Location", "amount-desc");

    expect(section(sections, "fridge").data.map((r) => [r.name, r.total])).toEqual([
      ["Cheese", 400],
      ["Butter", 250],
      ["Milk", 2000],
      ["Cream", 500],
      ["Eggs", 12],
    ]);
  });

  it.each(expected.map(([sortBy]) => sortBy))("keeps the Category section order under %s", (sortBy) => {
    const kale = lot({ id: "k", food_id: "kale", name: "Kale", category: produce, expiration_date: inDays(2) });

    const labels = sorted([...kitchen(), kale], "Category", sortBy).map((s) => s.label);

    expect(labels).toEqual(["Produce", "Dairy"]);
  });

  it("ranks a food under Recently added by its newest batch", () => {
    const restockedMilk = lot({
      id: "milk-2",
      food_id: "milk",
      name: "Milk",
      unit: "ml",
      quantity: 1000,
      category: dairy,
      expiration_date: inDays(12),
      created_at: "2026-11-07T12:00:00+00:00",
    });
    const rows = section(sorted([...kitchen(), restockedMilk], "Location", "recent"), "fridge").data;

    expect(rows.map((r) => r.name)).toEqual(["Milk", "Cream", "Cheese", "Butter", "Eggs"]);
  });

  it("orders the Expired section least overdue first under latest first", () => {
    const sour = (name: string, days: number) => food(name, "g", 100, days, "1");

    const rows = section(sorted([sour("Ham", -9), sour("Kefir", -1), sour("Brie", -4)], "Urgency", "expiry-latest"), "expired").data;

    expect(rows.map((r) => r.name)).toEqual(["Kefir", "Brie", "Ham"]);
  });
});
