import type { InventoryItem } from "@/hooks/useInventoryItems";
import { groupFoodRows, inDrawOrder, stackLots, type DrawnLot, type FoodSection } from "@/lib/foodRows";

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
    category: null,
    ...overrides,
  };
}

const milk = (id: string, days: number | null, extra: Partial<InventoryItem> = {}) =>
  lot({
    id,
    food_id: "milk",
    name: "Milk",
    unit: "ml",
    quantity: 1000,
    category: dairy,
    expiration_date: days === null ? null : inDays(days),
    ...extra,
  });

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

describe("stackLots", () => {
  it("stacks two batches of one food into one row with their total, soonest first", () => {
    const [row, ...rest] = stackLots([milk("late", 9), milk("early", 3)]);

    expect(rest).toEqual([]);
    expect(row).toMatchObject({
      foodId: "milk",
      name: "Milk",
      unit: "ml",
      total: 2000,
      locations: ["fridge"],
      days: 3,
      expiredLots: 0,
    });
    expect(row.lots.map((l) => l.id)).toEqual(["early", "late"]);
  });

  it("drives urgency by the soonest unexpired batch when an older one has expired", () => {
    const [row] = stackLots([milk("old", -2), milk("new", 5)]);

    expect(row.days).toBe(5);
    expect(row.expiredLots).toBe(1);
    expect(row.lots.map((l) => l.id)).toEqual(["old", "new"]);
  });

  it("treats an undated batch as unexpired, so an expired one beside it does not mark the food expired", () => {
    const [row] = stackLots([milk("old", -2), milk("undated", null)]);

    expect(row).toMatchObject({ days: null, urgency: "fresh", expiredLots: 1 });
  });

  it("reports the most overdue batch when every batch has expired", () => {
    const [row] = stackLots([milk("a", -1), milk("b", -4)]);

    expect(row.days).toBe(-4);
    expect(row.expiredLots).toBe(2);
  });

  it("keeps undated batches after dated ones and has no days when nothing is dated", () => {
    expect(stackLots([milk("undated", null), milk("dated", 4)])[0].lots.map((l) => l.id)).toEqual([
      "dated",
      "undated",
    ]);
    expect(stackLots([milk("undated", null)])[0].days).toBeNull();
  });

  it("lists distinct locations in fridge, freezer, pantry order", () => {
    const [row] = stackLots([
      milk("p", 3, { storage_location: "pantry" }),
      milk("f", 4, { storage_location: "freezer" }),
      milk("r", 5),
    ]);

    expect(row.locations).toEqual(["fridge", "freezer", "pantry"]);
  });

  it("sorts rows by urgency, undated last, then by name", () => {
    const rows = stackLots([
      lot({ id: "1", food_id: "rice", name: "Rice" }),
      lot({ id: "2", food_id: "eggs", name: "Eggs", expiration_date: inDays(2) }),
      lot({ id: "3", food_id: "apples", name: "Apples", expiration_date: inDays(2) }),
      lot({ id: "4", food_id: "beans", name: "Beans" }),
      lot({ id: "5", food_id: "ham", name: "Ham", expiration_date: inDays(-1) }),
    ]);

    expect(rows.map((r) => r.name)).toEqual(["Ham", "Apples", "Eggs", "Beans", "Rice"]);
  });
});

describe("groupFoodRows", () => {
  it("places each food once in the Urgency view by its stacked urgency", () => {
    const sections = groupFoodRows(
      [
        milk("old", -2),
        milk("new", 5),
        lot({ id: "y", food_id: "yogurt", name: "Yogurt", expiration_date: inDays(-3) }),
        lot({ id: "e", food_id: "eggs", name: "Eggs", expiration_date: inDays(1) }),
        lot({ id: "s", food_id: "salt", name: "Salt" }),
      ],
      "Urgency",
    );

    expect(sections.map((s) => [s.key, s.data.map((r) => r.name)])).toEqual([
      ["expired", ["Yogurt"]],
      ["today", ["Eggs"]],
      ["week", ["Milk"]],
      ["fresh", ["Salt"]],
    ]);
    expect(section(sections, "week").data[0].lots).toHaveLength(2);
  });

  it("splits a food across places in the Location view, each row holding that place's batches", () => {
    const sections = groupFoodRows(
      [milk("cold", 3), milk("frozen", 60, { storage_location: "freezer" }), milk("cold2", 6)],
      "Location",
    );

    const fridge = section(sections, "fridge").data;
    const freezer = section(sections, "freezer").data;
    expect(fridge).toHaveLength(1);
    expect(fridge[0]).toMatchObject({ total: 2000, locations: ["fridge"] });
    expect(fridge[0].lots.map((l) => l.id)).toEqual(["cold", "cold2"]);
    expect(freezer[0]).toMatchObject({ total: 1000, locations: ["freezer"] });
    expect(section(sections, "pantry").data).toEqual([]);
    expect(fridge[0].key).not.toBe(freezer[0].key);
  });

  it("holds one row per food in the Category view, uncategorized foods grouped together", () => {
    const sections = groupFoodRows(
      [
        milk("a", 3),
        milk("b", 8, { storage_location: "freezer" }),
        lot({ id: "k", food_id: "kale", name: "Kale", category: produce, expiration_date: inDays(1) }),
        lot({ id: "x", food_id: "mystery", name: "Mystery jar" }),
      ],
      "Category",
    );

    expect(sections.map((s) => [s.label, s.data.map((r) => r.name)])).toEqual([
      ["Produce", ["Kale"]],
      ["Dairy", ["Milk"]],
      ["Uncategorized", ["Mystery jar"]],
    ]);
    expect(section(sections, "cat-dairy").data[0].lots).toHaveLength(2);
  });
});

describe("inDrawOrder", () => {
  const ids = (drawn: DrawnLot[]) => drawn.map((d) => d.lot.id);
  const useFirst = (drawn: DrawnLot[]) => drawn.filter((d) => d.useFirst).map((d) => d.lot.id);

  it("draws an opened batch before a sealed one that expires sooner", () => {
    const drawn = inDrawOrder([
      milk("sealed", 2),
      milk("opened", 6, { opened_at: "2026-11-07T08:00:00+00:00" }),
    ]);

    expect(ids(drawn)).toEqual(["opened", "sealed"]);
    expect(useFirst(drawn)).toEqual(["opened"]);
  });

  it("draws the soonest-expiring batch next, undated batches after dated ones", () => {
    expect(ids(inDrawOrder([milk("undated", null), milk("late", 9), milk("soon", 1)]))).toEqual([
      "soon",
      "late",
      "undated",
    ]);
  });

  it("breaks ties by the oldest added batch", () => {
    const drawn = inDrawOrder([
      milk("newer", 4, { created_at: "2026-11-06T12:00:00+00:00" }),
      milk("older", 4, { created_at: "2026-11-02T12:00:00+00:00" }),
    ]);

    expect(ids(drawn)).toEqual(["older", "newer"]);
  });

  it("puts expired batches last and never marks one to use first", () => {
    const drawn = inDrawOrder([
      milk("expired", -3, { opened_at: "2026-11-01T08:00:00+00:00" }),
      milk("fresh", 5),
    ]);

    expect(ids(drawn)).toEqual(["fresh", "expired"]);
    expect(drawn.map((d) => d.expired)).toEqual([false, true]);
    expect(useFirst(drawn)).toEqual(["fresh"]);
  });

  it("marks no batch to use first when every batch has expired", () => {
    const drawn = inDrawOrder([milk("a", -1), milk("b", -4)]);

    expect(ids(drawn)).toEqual(["b", "a"]);
    expect(useFirst(drawn)).toEqual([]);
  });
});
