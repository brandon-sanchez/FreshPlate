// Mirrors `normalize_unit` and the unit tables in backend/app/inventory/units.py
// and the table and bare-word rules of `parse_unit` in
// backend/app/inventory/backfill.py. backend/tests/fixtures/stock_unit_cases.json
// holds the cases both sides must read the same way.

/**
 * A typed unit read as a food's stock. `perUnit` is the stock amount one of the
 * typed unit stands for (1000 for "kg"). A counted unit names its count word in
 * `eachLabel` ("can", or "each" for a generic item); measured units have none,
 * mirroring the CHECK on `foods` that ties `each_label` to stock base "each".
 */
export type StockUnit =
  | { stockBase: "g" | "ml"; eachLabel: null; perUnit: number }
  | { stockBase: "each"; eachLabel: string; perUnit: 1 };

const MASS = new Map([
  ["g", 1],
  ["kg", 1000],
  ["mg", 0.001],
  ["oz", 28.349523125],
  ["lb", 453.59237],
]);

const VOLUME = new Map([
  ["ml", 1],
  ["l", 1000],
  ["tsp", 4.92892159375],
  ["tbsp", 14.78676478125],
  ["fl oz", 29.5735295625],
  ["cup", 236.5882365],
  ["pt", 473.176473],
  ["qt", 946.352946],
  ["gal", 3785.411784],
]);

const SYNONYMS: Record<string, readonly string[]> = {
  g: ["gram"],
  kg: ["kilogram"],
  mg: ["milligram"],
  oz: ["ounce"],
  lb: ["pound"],
  ml: ["milliliter", "millilitre"],
  l: ["liter", "litre"],
  tsp: ["teaspoon"],
  tbsp: ["tablespoon", "tbs", "tbl"],
  cup: ["c"],
  "fl oz": ["fluid ounce"],
  pt: ["pint"],
  qt: ["quart"],
  gal: ["gallon"],
  head: ["bulb"],
  each: ["", "item", "piece", "pc", "whole", "ea", "ct", "count"],
};

const ALIASES = new Map(
  Object.entries(SYNONYMS).flatMap(([key, words]) =>
    words.map((word) => [word, key] as const),
  ),
);

const ABBREVIATION_PERIOD = /\.(?!\d)/g;

const IRREGULAR_PLURALS = new Map([
  ...["g", "kg", "lb", "ml", "oz", "pt", "qt", "pc"].map(
    (key) => [`${key}s`, key] as const,
  ),
  ["leaves", "leaf"],
  ["loaves", "loaf"],
  ["halves", "half"],
  ["cookies", "cookie"],
  ["pies", "pie"],
]);

/**
 * Reads a unit as typed into the stock it adds to: "kg" is 1000 g, "Cups" is
 * 236.59 ml, and any other word ("Cans", "item") is counted, labelled with its
 * singular form ("can", "each"). An empty unit counts as a generic each.
 * Package forms such as "Containers (63 g each)" are not parsed; they count
 * under their whole normalized text.
 *
 * @param text - The unit as typed, in any case, singular or plural.
 */
export function readStockUnit(text: string): StockUnit {
  const key = normalizeUnit(text);
  const grams = MASS.get(key);
  if (grams !== undefined) return { stockBase: "g", eachLabel: null, perUnit: grams };
  const millilitres = VOLUME.get(key);
  if (millilitres !== undefined) {
    return { stockBase: "ml", eachLabel: null, perUnit: millilitres };
  }
  return { stockBase: "each", eachLabel: key, perUnit: 1 };
}

/**
 * Converts an amount of a typed unit into the food's stock base: 1.5 kg is
 * 1500 g. Rounds to 12 significant digits so binary float noise
 * (1.005 * 1000 = 1004.9999999999999) never reaches the database.
 *
 * @param quantity - The amount as typed.
 * @param unit - The unit read by {@link readStockUnit}.
 */
export function toStockAmount(quantity: number, unit: StockUnit): number {
  return Number((quantity * unit.perUnit).toPrecision(12));
}

function normalizeUnit(text: string): string {
  let words = text
    .toLowerCase()
    .replace(ABBREVIATION_PERIOD, "")
    .split(/\s+/)
    .filter((word) => word.length > 0)
    .map(singular);
  if (words[0] === "a" || words[0] === "an") words = words.slice(1);
  const key = words.join(" ");
  return ALIASES.get(key) ?? key;
}

function singular(word: string): string {
  const irregular = IRREGULAR_PLURALS.get(word);
  if (irregular !== undefined) return irregular;
  if (word.length <= 3 || /(ss|us|is)$/.test(word)) return word;
  if (word.endsWith("ies")) return `${word.slice(0, -3)}y`;
  if (/(oes|ches|shes|xes|sses)$/.test(word)) return word.slice(0, -2);
  if (word.endsWith("s")) return word.slice(0, -1);
  return word;
}
