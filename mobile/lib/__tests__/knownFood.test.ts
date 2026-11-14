import { findFood, KnownFood, suggestFoods } from "@/lib/knownFood";

function food(
  name: string,
  status: KnownFood["status"] = { kind: "live" },
): KnownFood {
  return {
    id: name,
    name,
    nameKey: name.replace(/\s+/g, " ").trim().toLowerCase(),
    categoryId: null,
    stock: { base: "g" },
    lastLot: null,
    status,
  };
}

const names = (foods: KnownFood[]) => foods.map((f) => f.name);

describe("suggestFoods", () => {
  const foods = [
    "Oat milk",
    "Mozzarella",
    "Milk",
    "Buttermilk",
    "Milk chocolate",
    "Mint",
  ].map((name) => food(name));

  it("shows the six most recent foods for a blank name", () => {
    const many = [...foods, food("Rice"), food("Eggs")];
    expect(names(suggestFoods(many, "  "))).toEqual(names(many.slice(0, 6)));
  });

  it("ranks name prefixes before word prefixes, keeping recency within each", () => {
    expect(names(suggestFoods(foods, "mi"))).toEqual([
      "Milk",
      "Milk chocolate",
      "Mint",
      "Oat milk",
    ]);
  });

  it("skips mid-word matches and the food the name already matches", () => {
    expect(names(suggestFoods(foods, " MILK "))).toEqual([
      "Milk chocolate",
      "Oat milk",
    ]);
  });

  it("returns at most six foods", () => {
    const many = Array.from({ length: 9 }, (_, i) => food(`Apple ${i}`));
    expect(suggestFoods(many, "app")).toHaveLength(6);
  });

  it("suggests only foods the household still sees", () => {
    const foods = [
      food("Milk", { kind: "archived" }),
      food("Whole milk", { kind: "merged", intoId: "Milk" }),
      food("Mint"),
    ];
    expect(names(suggestFoods(foods, ""))).toEqual(["Mint"]);
    expect(names(suggestFoods(foods, "m"))).toEqual(["Mint"]);
  });
});

describe("findFood", () => {
  it.each([
    ["Milk", "Milk"],
    ["  MILK ", "Milk"],
    ["oat milk", "Oat  milk"],
    ["Oat\tMilk", "Oat  milk"],
  ])("matches %p the way the database keys names", (typed, expected) => {
    const foods = [food("Oat  milk"), food("Milk")];
    expect(findFood(foods, typed)?.name).toBe(expected);
  });

  it.each(["", "   ", "Milk shake", "Oatmilk"])(
    "finds nothing for %p",
    (typed) => {
      expect(findFood([food("Oat milk"), food("Milk")], typed)).toBeNull();
    },
  );

  it("compares against the key the database stored", () => {
    const stored = { ...food("Crème fraîche"), nameKey: "creme fraiche" };
    expect(findFood([stored], "Creme Fraiche")).toBe(stored);
  });

  it("finds an archived food, which an add brings back", () => {
    const archived = food("Milk", { kind: "archived" });
    expect(findFood([archived], "milk")).toBe(archived);
  });

  it("follows merged foods to the one that takes their adds", () => {
    const milk = food("Milk");
    const foods = [
      food("Whole milk", { kind: "merged", intoId: "Full fat milk" }),
      food("Full fat milk", { kind: "merged", intoId: "Milk" }),
      milk,
    ];
    expect(findFood(foods, "whole milk")).toBe(milk);
  });

  it("finds nothing when a merge chain does not end", () => {
    const foods = [
      food("A", { kind: "merged", intoId: "B" }),
      food("B", { kind: "merged", intoId: "A" }),
    ];
    expect(findFood(foods, "a")).toBeNull();
  });
});
