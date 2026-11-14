import type { KnownFood, LastLot } from "@/lib/knownFood";
import {
  AmountDraft,
  draftFromBarcode,
  draftFromLastLot,
  fitDraftToFood,
  LotAmount,
  packageWordChoices,
  resolveAmount,
  toAddLotArgs,
  unitChips,
  withSizeAmount,
  withSizeUnit,
} from "@/lib/lotAmount";
import type { Measure } from "@/lib/stockUnit";

function lot(overrides: Partial<LastLot> = {}): LastLot {
  return {
    storage: "fridge",
    shelfLifeDays: 7,
    initialQuantity: null,
    package: null,
    ...overrides,
  };
}

function knownFood(
  id: string,
  name: string,
  stock: KnownFood["stock"],
  lastLot: LastLot | null = null,
): KnownFood {
  return {
    id,
    name,
    nameKey: name.toLowerCase(),
    categoryId: null,
    stock,
    lastLot,
    status: { kind: "live" },
  };
}

const cokeMeasured = knownFood("coke-ml", "Coke", { base: "ml" });
const cokeCounted = knownFood(
  "coke-each",
  "Coke",
  { base: "each", eachLabel: "can", sizeEach: { amount: 330, base: "ml" } },
  lot({ initialQuantity: 6 }),
);
const yogurt = knownFood("yogurt", "Yogurt", { base: "g" });
const milk = knownFood(
  "milk",
  "Milk",
  { base: "ml" },
  lot({ initialQuantity: 2000, package: { label: "bottle", size: 1000 } }),
);
const rice = knownFood(
  "rice",
  "Rice",
  { base: "g" },
  lot({ storage: "pantry", initialQuantity: 1500 }),
);

const measure = (amount: string, unit: Measure): AmountDraft => ({
  kind: "measure",
  unit,
  amount,
});
const count = (label: string, n: number): AmountDraft => ({
  kind: "count",
  label,
  count: n,
});
const pack = (
  label: string,
  n: number,
  size: { amount: string; unit: Measure } | null = null,
) => ({ kind: "package" as const, label, count: n, size });

describe("resolveAmount", () => {
  it.each<[string, AmountDraft, KnownFood | null, LotAmount]>([
    [
      "1.5 kg of a new food",
      measure("1.5", "kg"),
      null,
      { stockBase: "g", quantity: 1500, package: null },
    ],
    [
      "a decimal comma",
      measure("0,5", "l"),
      null,
      { stockBase: "ml", quantity: 500, package: null },
    ],
    [
      "2 bottles of 1 l",
      pack("bottle", 2, { amount: "1", unit: "l" }),
      null,
      {
        stockBase: "ml",
        quantity: 2000,
        package: { label: "bottle", size: 1000 },
      },
    ],
    [
      "3 packs of 0.1 l without float noise",
      pack("pack", 3, { amount: "0.1", unit: "l" }),
      null,
      { stockBase: "ml", quantity: 300, package: { label: "pack", size: 100 } },
    ],
    [
      "2 bottles of unknown size",
      pack("bottle", 2),
      null,
      { stockBase: "each", eachLabel: "bottle", quantity: 2 },
    ],
    [
      "a blank package size",
      pack("bottle", 2, { amount: " ", unit: "l" }),
      null,
      { stockBase: "each", eachLabel: "bottle", quantity: 2 },
    ],
    [
      "6 each",
      count("each", 6),
      null,
      { stockBase: "each", eachLabel: "each", quantity: 6 },
    ],
    [
      "just a container",
      count("container", 1),
      null,
      { stockBase: "each", eachLabel: "container", quantity: 1 },
    ],
    [
      "6 cans of 330 ml on a food tracked in ml",
      pack("can", 6, { amount: "330", unit: "ml" }),
      cokeMeasured,
      { stockBase: "ml", quantity: 1980, package: { label: "can", size: 330 } },
    ],
    [
      "6 cans on a food counted in cans",
      pack("can", 6, { amount: "330", unit: "ml" }),
      cokeCounted,
      { stockBase: "each", eachLabel: "can", quantity: 6 },
    ],
  ])("stores %s", (_, draft, food, expected) => {
    expect(resolveAmount(draft, food)).toEqual({ ok: true, amount: expected });
  });

  it.each<[string, AmountDraft, KnownFood | null, string]>([
    [
      "an unsized tub on a food tracked in g",
      pack("tub", 1),
      yogurt,
      "Add the tub size",
    ],
    [
      "a blank amount",
      measure("", "g"),
      null,
      "Enter an amount greater than 0",
    ],
    [
      "a zero amount",
      measure("0", "kg"),
      null,
      "Enter an amount greater than 0",
    ],
    [
      "text that is not a number",
      measure("1.2.3", "g"),
      null,
      "Enter an amount greater than 0",
    ],
    [
      "a zero package size",
      pack("jar", 1, { amount: "0", unit: "g" }),
      null,
      "Enter a package size greater than 0",
    ],
    [
      "ml on a food tracked in g",
      measure("200", "ml"),
      yogurt,
      "Yogurt is tracked in g.",
    ],
    [
      "a count on a food tracked in g",
      count("each", 2),
      yogurt,
      "Yogurt is tracked in g.",
    ],
    [
      "a weight on a counted food",
      measure("200", "g"),
      cokeCounted,
      "Coke is counted by the can (330 ml each).",
    ],
  ])("rejects %s", (_, draft, food, error) => {
    expect(resolveAmount(draft, food)).toEqual({ ok: false, error });
  });
});

describe("unitChips", () => {
  const labels = (food: KnownFood | null, draft: AmountDraft) =>
    unitChips(food, draft).map((chip) => chip.label);
  const selected = (food: KnownFood | null, draft: AmountDraft) =>
    unitChips(food, draft)
      .filter((chip) => chip.selected)
      .map((chip) => chip.label);
  const press = (food: KnownFood | null, draft: AmountDraft, label: string) =>
    unitChips(food, draft).find((chip) => chip.label === label)?.draft;

  it("offers every unit for a new food", () => {
    expect(labels(null, count("each", 1))).toEqual([
      "g",
      "kg",
      "ml",
      "l",
      "each",
      "Package",
      "Just a container",
    ]);
  });

  it("offers only the food's own units for a measured food", () => {
    expect(labels(yogurt, measure("500", "g"))).toEqual(["g", "kg", "Package"]);
  });

  it("offers only the count word for a counted food", () => {
    expect(labels(cokeCounted, count("can", 6))).toEqual(["can"]);
    expect(selected(cokeCounted, count("can", 6))).toEqual(["can"]);
  });

  it.each<[AmountDraft, string]>([
    [measure("2", "kg"), "kg"],
    [count("each", 3), "each"],
    [count("container", 1), "Just a container"],
    [pack("tub", 1), "Package"],
  ])("selects the chip of the draft %j", (draft, label) => {
    expect(selected(null, draft)).toEqual([label]);
  });

  it("keeps the typed amount when switching between weights", () => {
    expect(press(null, measure("500", "g"), "kg")).toEqual(
      measure("500", "kg"),
    );
  });

  it("keeps the count when switching between counts", () => {
    expect(press(null, count("each", 4), "Just a container")).toEqual(
      count("container", 4),
    );
  });

  it("keeps the draft when its own chip is pressed", () => {
    const draft = pack("jar", 2, { amount: "250", unit: "g" });
    expect(press(null, draft, "Package")).toBe(draft);
  });

  it("starts a measured food's package from its last package", () => {
    expect(press(milk, measure("1", "l"), "Package")).toEqual(
      pack("bottle", 1, { amount: "1", unit: "l" }),
    );
  });
});

describe("package edits", () => {
  it("offers the package words with the draft's word selected", () => {
    const choices = packageWordChoices(pack("jar", 2));
    expect(choices.map((c) => c.label)).toEqual([
      "bottle",
      "carton",
      "can",
      "jar",
      "bag",
      "box",
      "tub",
      "pack",
    ]);
    expect(choices.filter((c) => c.selected).map((c) => c.label)).toEqual([
      "jar",
    ]);
    expect(choices.find((c) => c.label === "tub")?.draft).toEqual(
      pack("tub", 2),
    );
  });

  it("offers a word from a last lot first", () => {
    expect(packageWordChoices(pack("crate", 1))[0]).toMatchObject({
      label: "crate",
      selected: true,
    });
  });

  it.each<[string, ReturnType<typeof pack>, KnownFood | null, Measure]>([
    ["ml for a liquid package", pack("bottle", 1), null, "ml"],
    ["g for any other package", pack("jar", 1), null, "g"],
    ["the food's stock base", pack("bottle", 1), yogurt, "g"],
    [
      "the unit already chosen",
      pack("jar", 1, { amount: "", unit: "kg" }),
      null,
      "kg",
    ],
  ])("sizes a package in %s", (_, draft, food, unit) => {
    expect(withSizeAmount(draft, "2", food).size).toEqual({
      amount: "2",
      unit,
    });
  });

  it("changes the size unit and keeps the typed number", () => {
    expect(
      withSizeUnit(pack("jar", 1, { amount: "1.5", unit: "g" }), "kg").size,
    ).toEqual({ amount: "1.5", unit: "kg" });
    expect(withSizeUnit(pack("jar", 1), "l").size).toEqual({
      amount: "",
      unit: "l",
    });
  });
});

describe("draftFromLastLot", () => {
  it.each<[string, KnownFood, AmountDraft]>([
    ["two 1 l bottles", milk, pack("bottle", 2, { amount: "1", unit: "l" })],
    ["1.5 kg as kg", rice, measure("1.5", "kg")],
    ["six cans", cokeCounted, count("can", 6)],
    ["a blank amount when the food has no lot", yogurt, measure("", "g")],
    [
      "one package when the starting amount is unknown",
      { ...milk, lastLot: lot({ package: { label: "carton", size: 500 } }) },
      pack("carton", 1, { amount: "500", unit: "ml" }),
    ],
  ])("repeats %s", (_, food, expected) => {
    expect(draftFromLastLot(food)).toEqual(expected);
  });
});

describe("fitDraftToFood", () => {
  const drafts: AmountDraft[] = [
    measure("2", "kg"),
    measure("750", "ml"),
    count("each", 3),
    count("container", 1),
    count("can", 4),
    pack("bottle", 2),
    pack("bottle", 2, { amount: "1", unit: "l" }),
    pack("bag", 1, { amount: "500", unit: "g" }),
  ];
  const foods: (KnownFood | null)[] = [
    null,
    milk,
    rice,
    yogurt,
    cokeCounted,
    cokeMeasured,
  ];

  it.each(foods.map((food) => [food?.id ?? "a new food", food] as const))(
    "is idempotent and never leaves a stock mismatch for %s",
    (_, food) => {
      for (const draft of drafts) {
        const fitted = fitDraftToFood(draft, food);
        expect(fitDraftToFood(fitted, food)).toBe(fitted);
        const resolved = resolveAmount(fitted, food);
        if (food && resolved.ok) {
          expect(resolved.amount.stockBase).toBe(food.stock.base);
        }
        expect(unitChips(food, fitted).filter((c) => c.selected)).toHaveLength(
          1,
        );
      }
    },
  );

  it("keeps a draft that already fits", () => {
    const draft = measure("2", "kg");
    expect(fitDraftToFood(draft, rice)).toBe(draft);
  });

  it("keeps an unsized package on a measured food so its size can be typed", () => {
    const draft = pack("tub", 1);
    expect(fitDraftToFood(draft, yogurt)).toBe(draft);
  });

  it("keeps the count when relabelling for a counted food", () => {
    expect(
      fitDraftToFood(
        pack("pack", 12, { amount: "330", unit: "ml" }),
        cokeCounted,
      ),
    ).toEqual(count("can", 12));
  });

  it("turns a counted food's word into a package for a new food", () => {
    expect(fitDraftToFood(count("can", 6), null)).toEqual(pack("can", 6));
  });

  it("falls back to the last purchase when the unit cannot fit", () => {
    expect(fitDraftToFood(measure("3", "kg"), milk)).toEqual(
      draftFromLastLot(milk),
    );
  });
});

describe("toAddLotArgs", () => {
  it.each<[string, LotAmount, Record<string, unknown>]>([
    [
      "a count with its each label",
      { stockBase: "each", eachLabel: "bag", quantity: 2 },
      {
        p_stock_base: "each",
        p_quantity: 2,
        p_each_label: "bag",
        p_package_size: null,
        p_package_label: null,
      },
    ],
    [
      "a loose weight",
      { stockBase: "g", quantity: 1500, package: null },
      {
        p_stock_base: "g",
        p_quantity: 1500,
        p_each_label: null,
        p_package_size: null,
        p_package_label: null,
      },
    ],
    [
      "packages of a known size",
      {
        stockBase: "ml",
        quantity: 2000,
        package: { label: "bottle", size: 1000 },
      },
      {
        p_stock_base: "ml",
        p_quantity: 2000,
        p_each_label: null,
        p_package_size: 1000,
        p_package_label: "bottle",
      },
    ],
  ])("passes %s", (_, amount, args) => {
    expect(toAddLotArgs(amount)).toEqual(args);
  });
});

describe("draftFromBarcode", () => {
  it.each<[string, AmountDraft]>([
    ["500 g", pack("pack", 1, { amount: "500", unit: "g" })],
    ["1L", pack("pack", 1, { amount: "1", unit: "l" })],
    ["0,5 kg", pack("pack", 1, { amount: "500", unit: "g" })],
    ["17.6 oz tub", pack("tub", 1, { amount: "499", unit: "g" })],
    ["16.9 fl oz", pack("pack", 1, { amount: "499.8", unit: "ml" })],
    ["12 FL. OZ", pack("pack", 1, { amount: "354.9", unit: "ml" })],
    ["6 x 330 ml", pack("pack", 6, { amount: "330", unit: "ml" })],
    ["6 x 330 ml cans", pack("can", 6, { amount: "330", unit: "ml" })],
    ["2×1.5L", pack("pack", 2, { amount: "1.5", unit: "l" })],
    ["12", count("each", 12)],
    ["12 pieces", count("each", 12)],
    ["4 cans", pack("can", 4)],
  ])("reads %p", (text, expected) => {
    expect(draftFromBarcode(text)).toEqual(expected);
  });

  it.each([null, "", "about a pound", "0 g", "1.5 x 2 l", "33 cl", "500 gr"])(
    "reads %p as one package of unknown size",
    (text) => {
      expect(draftFromBarcode(text)).toEqual(pack("pack", 1));
    },
  );

  it("stores a multipack as one lot of its total", () => {
    expect(resolveAmount(draftFromBarcode("6 x 330 ml"), null)).toEqual({
      ok: true,
      amount: {
        stockBase: "ml",
        quantity: 1980,
        package: { label: "pack", size: 330 },
      },
    });
  });
});
