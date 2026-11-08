import {
  MEASURES,
  measuresFor,
  readStockUnit,
  toMeasure,
  toStockAmount,
} from "@/lib/stockUnit";

type SharedCase = {
  unit: string;
  stock_base: string;
  each_label: string | null;
  per_unit: string;
};

// The backend backfill tests read the same cases, so both sides agree on how a
// table unit or a bare word maps onto a food.
const sharedCases: SharedCase[] = require("../../../backend/tests/fixtures/stock_unit_cases.json");

describe("readStockUnit", () => {
  it.each(sharedCases.map((c) => [c.unit, c] as const))(
    "reads %j the way the backfill does",
    (unit, expected) => {
      const read = readStockUnit(unit);
      expect(read.stockBase).toBe(expected.stock_base);
      expect(read.eachLabel).toBe(expected.each_label);
      expect(read.perUnit).toBeCloseTo(Number(expected.per_unit), 9);
    },
  );

  it("counts an empty unit as a generic each", () => {
    expect(readStockUnit("")).toEqual({
      stockBase: "each",
      eachLabel: "each",
      perUnit: 1,
    });
  });

  it("does not treat object prototype names as table units", () => {
    expect(readStockUnit("constructor")).toEqual({
      stockBase: "each",
      eachLabel: "constructor",
      perUnit: 1,
    });
  });
});

describe("toStockAmount", () => {
  it("converts into the stock base without float noise", () => {
    expect(toStockAmount(1.005, readStockUnit("kg"))).toBe(1005);
    expect(toStockAmount(6, readStockUnit("eggs"))).toBe(6);
  });
});

describe("measures", () => {
  it("lists a base's measures smallest first, or every measure for an unknown base", () => {
    expect(measuresFor("g")).toEqual(["g", "kg"]);
    expect(measuresFor("ml")).toEqual(["ml", "l"]);
    expect(measuresFor(null)).toEqual(["g", "kg", "ml", "l"]);
  });

  it.each(measuresFor(null))("reads %s the way a typed unit reads", (unit) => {
    expect(readStockUnit(unit)).toEqual(MEASURES[unit]);
  });

  it.each<[number, "g" | "ml", ReturnType<typeof toMeasure>]>([
    [1500, "g", { amount: 1.5, unit: "kg" }],
    [1000, "ml", { amount: 1, unit: "l" }],
    [999, "ml", { amount: 999, unit: "ml" }],
    [1004.9999999999999, "g", { amount: 1.005, unit: "kg" }],
  ])(
    "expresses %p %s in the largest measure at or above 1",
    (amount, base, expected) => {
      expect(toMeasure(amount, base)).toEqual(expected);
    },
  );
});
