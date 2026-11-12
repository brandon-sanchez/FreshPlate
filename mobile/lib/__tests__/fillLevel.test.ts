import { currentFillLevel, parseExactAmount, remainingMode } from "@/lib/fillLevel";
import { formatAmount } from "@/lib/amount";

const lot = (quantity: number, initial_quantity: number | null, whole_units_only = false) => ({
  quantity,
  initial_quantity,
  whole_units_only,
});

it.each([
  [lot(500, 1000), "levels"],
  [lot(120, null), "unknownSize"],
  [lot(3, 6, true), "count"],
])("sets %p by %p", (batch, mode) => {
  expect(remainingMode(batch)).toBe(mode);
});

it("matches an amount to its fill level, and nothing else", () => {
  expect(currentFillLevel(lot(750, 1000))?.label).toBe("3/4");
  expect(currentFillLevel(lot(1000, 1000))?.label).toBe("Full");
  expect(currentFillLevel(lot(600, 1000))).toBeNull();
  expect(currentFillLevel(lot(600, null))).toBeNull();
});

it.each([
  ["320", false, 320],
  ["320,5", false, 320.5],
  [" 2 ", true, 2],
  ["", false, null],
  ["0", false, null],
  ["-2", false, null],
  ["abc", false, null],
  ["Infinity", false, null],
  ["1.5", true, null],
])("parses %p (whole units only: %p) as %p", (text, whole, expected) => {
  expect(parseExactAmount(text, whole)).toBe(expected);
});

it("formats amounts to two decimals and says about for estimates", () => {
  expect(formatAmount(750, "ml", true)).toBe("about 750 ml");
  expect(formatAmount(0.25, "container", true)).toBe("about 0.25 container");
  expect(formatAmount(1.25, "head", false)).toBe("1.25 head");
  expect(formatAmount(1000 / 3, "g", false)).toBe("333.33 g");
});
