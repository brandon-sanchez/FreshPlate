import { readStockUnit, toStockAmount } from "@/lib/stockUnit";

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
    expect(readStockUnit("")).toEqual({ stockBase: "each", eachLabel: "each", perUnit: 1 });
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
