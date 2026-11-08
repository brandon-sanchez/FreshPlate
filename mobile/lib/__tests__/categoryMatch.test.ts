import { parseQuantity } from "@/lib/categoryMatch";

describe("parseQuantity", () => {
  it.each([
    ["1L", { quantity: 1, unit: "l" }],
    ["500 g", { quantity: 500, unit: "g" }],
    ["17.6 oz tub", { quantity: 17.6, unit: "oz" }],
    ["0,5 kg", { quantity: 0.5, unit: "kg" }],
    ["16.9 fl oz", { quantity: 16.9, unit: "fl oz" }],
    ["12 FL. OZ", { quantity: 12, unit: "fl oz" }],
    ["6 x 330 ml", { quantity: 1980, unit: "ml" }],
    ["2×1.5L", { quantity: 3, unit: "l" }],
    ["12", { quantity: 12, unit: "item" }],
  ])("reads %p", (raw, expected) => {
    expect(parseQuantity(raw)).toEqual(expected);
  });

  it.each([null, "", "about a pound", "0 g"])("returns null for %p", (raw) => {
    expect(parseQuantity(raw)).toBeNull();
  });
});
