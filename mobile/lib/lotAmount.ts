import type { KnownFood } from "@/lib/knownFood";
import {
  Measure,
  MeasuredBase,
  MEASURES,
  measuresFor,
  readStockUnit,
  roundAmount,
  toMeasure,
  toStockAmount,
} from "@/lib/stockUnit";

/**
 * The size of one package as typed, such as "1" and "l". The amount is text so
 * a half-typed "1." survives, and blank text means the size is unknown.
 */
type SizeDraft = { amount: string; unit: Measure };

/**
 * The amount control's state.
 * - `measure`: a typed weight or volume, such as "500" g.
 * - `count`: a whole number (at least 1) of `label`, which is "each",
 *   "container", or a counted food's own word.
 * - `package`: how many packages called `label`, with one package's size, or
 *   `null` when the size is unknown.
 */
export type AmountDraft =
  | { kind: "measure"; unit: Measure; amount: string }
  | { kind: "count"; label: string; count: number }
  | { kind: "package"; label: string; count: number; size: SizeDraft | null };

type PackageDraft = Extract<AmountDraft, { kind: "package" }>;

/**
 * The amount `add_lot` stores, already in the food's stock base. Mirrors the
 * CHECK on `foods`: only a counted lot has an each label, and only a measured
 * lot can carry a package label and size (display only, in the stock base).
 */
export type LotAmount =
  | {
      stockBase: MeasuredBase;
      quantity: number;
      package: { label: string; size: number } | null;
    }
  | { stockBase: "each"; eachLabel: string; quantity: number };

/** A chip the amount control shows, and the draft that pressing it produces. */
type Choice = { label: string; selected: boolean; draft: AmountDraft };

/**
 * Package words the form offers. Display words only: the backend converts a
 * measured lot by its stock amount, and treats the word of a counted lot as its
 * count label. `liquid` picks ml over g as a new food's package size unit.
 */
const PACKAGES = {
  bottle: { liquid: true },
  carton: { liquid: true },
  can: { liquid: true },
  jar: { liquid: false },
  bag: { liquid: false },
  box: { liquid: false },
  tub: { liquid: false },
  pack: { liquid: false },
} as const satisfies Record<string, { liquid: boolean }>;

type PackageWord = keyof typeof PACKAGES;

const PACKAGE_WORDS = Object.keys(PACKAGES) as PackageWord[];
const DEFAULT_PACKAGE: PackageWord = "pack";
const EACH = "each";
const CONTAINER = "container";

/**
 * Returns the chips for the unit row, with the one matching `draft` selected.
 * A new food (`food` is `null`) gets every chip: g, kg, ml, l, each,
 * "Package", and "Just a container". A food measured in g or ml gets its two
 * weight or volume units and "Package". A counted food gets only its own count
 * word, so the form can never send a stock base the food does not have.
 */
export function unitChips(
  food: KnownFood | null,
  draft: AmountDraft,
): Choice[] {
  const count = draft.kind === "measure" ? 1 : draft.count;
  if (food?.stock.base === "each") {
    const label = food.stock.eachLabel;
    return [choice(label, draft, { kind: "count", label, count })];
  }

  const base = food ? food.stock.base : null;
  const typed = draft.kind === "measure" ? draft.amount : "";
  const chips = measuresFor(base).map((unit) =>
    choice(unit, draft, { kind: "measure", unit, amount: typed }),
  );
  if (!food) {
    chips.push(choice(EACH, draft, { kind: "count", label: EACH, count }));
  }
  const last = food?.lastLot?.package ?? null;
  chips.push(
    choice("Package", draft, {
      kind: "package",
      label: last?.label ?? DEFAULT_PACKAGE,
      count,
      size: last && base ? sizeDraft(last.size, base) : null,
    }),
  );
  if (!food) {
    chips.push(
      choice("Just a container", draft, {
        kind: "count",
        label: CONTAINER,
        count,
      }),
    );
  }
  return chips;
}

/**
 * Returns the package word chips. A word outside the offered list, such as one
 * from a food's last lot, is offered first so it stays selectable.
 */
export function packageWordChoices(draft: PackageDraft): Choice[] {
  const words: string[] = isPackageWord(draft.label)
    ? PACKAGE_WORDS
    : [draft.label, ...PACKAGE_WORDS];
  return words.map((label) => ({
    label,
    selected: label === draft.label,
    draft: { ...draft, label },
  }));
}

/**
 * Returns the draft with a typed package size. The size keeps the unit already
 * chosen, else takes the food's stock base, else ml for a liquid package word
 * and g for any other.
 */
export function withSizeAmount(
  draft: PackageDraft,
  amount: string,
  food: KnownFood | null,
): PackageDraft {
  const fallback: Measure =
    food && food.stock.base !== "each"
      ? food.stock.base
      : isPackageWord(draft.label) && PACKAGES[draft.label].liquid
        ? "ml"
        : "g";
  return { ...draft, size: { amount, unit: draft.size?.unit ?? fallback } };
}

/** Returns the draft with the package size in another unit, keeping the typed number. */
export function withSizeUnit(draft: PackageDraft, unit: Measure): PackageDraft {
  return { ...draft, size: { amount: draft.size?.amount ?? "", unit } };
}

/**
 * Turns the draft into the amount `add_lot` stores, or an inline error for the
 * amount field.
 * - A counted food stores a count of its own each label; the draft's word and
 *   size are ignored, because the food's per-each size already applies.
 * - A package with a size stores count x size in g or ml, with the package
 *   label and size kept for display.
 * - A count, or a package without a size, stores a count of its word on a new
 *   food, and is an error on a measured food, which cannot hold counts.
 */
export function resolveAmount(
  draft: AmountDraft,
  food: KnownFood | null,
): { ok: true; amount: LotAmount } | { ok: false; error: string } {
  if (food?.stock.base === "each") {
    if (draft.kind === "measure") {
      return { ok: false, error: trackingNote(food) };
    }
    const eachLabel = food.stock.eachLabel;
    return {
      ok: true,
      amount: { stockBase: "each", eachLabel, quantity: draft.count },
    };
  }

  switch (draft.kind) {
    case "measure": {
      const value = parsePositive(draft.amount);
      if (value === null) {
        return { ok: false, error: "Enter an amount greater than 0" };
      }
      const unit = MEASURES[draft.unit];
      if (food && unit.stockBase !== food.stock.base) {
        return { ok: false, error: trackingNote(food) };
      }
      return {
        ok: true,
        amount: {
          stockBase: unit.stockBase,
          quantity: toStockAmount(value, unit),
          package: null,
        },
      };
    }
    case "count":
      if (food) return { ok: false, error: trackingNote(food) };
      return {
        ok: true,
        amount: {
          stockBase: "each",
          eachLabel: draft.label,
          quantity: draft.count,
        },
      };
    case "package": {
      if (draft.size === null || draft.size.amount.trim() === "") {
        if (food) return { ok: false, error: `Add the ${draft.label} size` };
        return {
          ok: true,
          amount: {
            stockBase: "each",
            eachLabel: draft.label,
            quantity: draft.count,
          },
        };
      }
      const size = parsePositive(draft.size.amount);
      if (size === null) {
        return { ok: false, error: "Enter a package size greater than 0" };
      }
      const unit = MEASURES[draft.size.unit];
      if (food && unit.stockBase !== food.stock.base) {
        return { ok: false, error: trackingNote(food) };
      }
      return {
        ok: true,
        amount: {
          stockBase: unit.stockBase,
          quantity: toStockAmount(draft.count * size, unit),
          package: { label: draft.label, size: toStockAmount(size, unit) },
        },
      };
    }
  }
}

/**
 * Returns a draft that {@link resolveAmount} can store for `food`, keeping the
 * user's draft when it already fits (kg on a food tracked in g stays kg, a
 * count stays a count of a counted food's word). Otherwise it falls back to
 * {@link draftFromLastLot}. A new food turns a count of a word other than
 * "each" or "container" into a package of that word. Returns `draft` itself
 * when it fits, so the form can derive the fitted draft on every render.
 */
export function fitDraftToFood(
  draft: AmountDraft,
  food: KnownFood | null,
): AmountDraft {
  if (!food) {
    const unoffered =
      draft.kind === "count" &&
      draft.label !== EACH &&
      draft.label !== CONTAINER;
    return unoffered
      ? { kind: "package", label: draft.label, count: draft.count, size: null }
      : draft;
  }
  const { stock } = food;
  if (stock.base === "each") {
    if (draft.kind === "measure") return draftFromLastLot(food);
    if (draft.kind === "count" && draft.label === stock.eachLabel) return draft;
    return { kind: "count", label: stock.eachLabel, count: draft.count };
  }
  switch (draft.kind) {
    case "measure":
      return MEASURES[draft.unit].stockBase === stock.base
        ? draft
        : draftFromLastLot(food);
    case "count":
      return draftFromLastLot(food);
    case "package":
      return draft.size === null ||
        MEASURES[draft.size.unit].stockBase === stock.base
        ? draft
        : draftFromLastLot(food);
  }
}

/**
 * Returns the draft that repeats the food's last purchase, such as 2 bottles
 * of 1 l, 6 cans, or 1.5 kg. A lot with no known starting amount, which the
 * backfill copied from `inventory_items`, gives a count of 1 or a blank amount.
 */
export function draftFromLastLot(food: KnownFood): AmountDraft {
  const lot = food.lastLot;
  const initial = lot?.initialQuantity ?? null;
  if (food.stock.base === "each") {
    return {
      kind: "count",
      label: food.stock.eachLabel,
      count: wholeCount(initial),
    };
  }
  if (lot?.package) {
    const { label, size } = lot.package;
    return {
      kind: "package",
      label,
      count: wholeCount(initial === null ? null : roundAmount(initial / size)),
      size: sizeDraft(size, food.stock.base),
    };
  }
  if (initial === null) {
    return { kind: "measure", unit: food.stock.base, amount: "" };
  }
  return { kind: "measure", ...sizeDraft(initial, food.stock.base) };
}

/**
 * Returns the sentence that tells the user how a food is stocked, such as
 * "Milk is tracked in ml." or "Coke is counted by the can (330 ml each)."
 */
export function trackingNote(food: KnownFood): string {
  const { stock } = food;
  if (stock.base !== "each") return `${food.name} is tracked in ${stock.base}.`;
  const size = stock.sizeEach
    ? ` (${stock.sizeEach.amount} ${stock.sizeEach.base} each)`
    : "";
  return `${food.name} is counted by the ${stock.eachLabel}${size}.`;
}

/** Returns the stock arguments of an `add_lot` call for the amount. */
export function toAddLotArgs(amount: LotAmount) {
  switch (amount.stockBase) {
    case "each":
      return {
        p_stock_base: amount.stockBase,
        p_quantity: amount.quantity,
        p_each_label: amount.eachLabel,
        p_package_size: null,
        p_package_label: null,
      };
    case "g":
    case "ml":
      return {
        p_stock_base: amount.stockBase,
        p_quantity: amount.quantity,
        p_each_label: null,
        p_package_size: amount.package?.size ?? null,
        p_package_label: amount.package?.label ?? null,
      };
  }
}

const NUMBER = String.raw`(\d+(?:[.,]\d+)?)`;
const UNIT = String.raw`(fl\.?\s*oz|[a-z]+)`;
const BARCODE_QUANTITY = new RegExp(
  String.raw`^${NUMBER}\s*(?:[x×]\s*${NUMBER}\s*)?${UNIT}?\s*(.*)$`,
  "i",
);

/**
 * Reads an Open Food Facts quantity string as one scanned package.
 * - "500 g" is 1 pack of 500 g, and "17.6 oz tub" is 1 tub of 499 g.
 * - "6 x 330 ml" is 6 packs of 330 ml: the multipack count is the package
 *   count, so the scan stays one lot.
 * - "12" or "12 pieces" is 12 each, and "4 cans" is 4 cans of unknown size.
 * - Missing or unreadable text, or a unit word that is neither a weight or
 *   volume nor an offered package word ("33 cl", "500 gr"), is 1 pack of
 *   unknown size.
 * The package word is the trailing word when the form offers it, else "pack".
 * Imperial sizes convert to g or ml, rounded to 0.1.
 */
export function draftFromBarcode(quantityText: string | null): AmountDraft {
  const unknown: AmountDraft = {
    kind: "package",
    label: DEFAULT_PACKAGE,
    count: 1,
    size: null,
  };
  const match = quantityText?.trim().match(BARCODE_QUANTITY);
  if (!match) return unknown;
  const [, first, second, unitText, rest] = match;
  const firstValue = parseDecimal(first);
  const count = second === undefined ? 1 : firstValue;
  const amount = second === undefined ? firstValue : parseDecimal(second);
  if (!(amount > 0) || !Number.isInteger(count) || count < 1) return unknown;

  const unit = readStockUnit(unitText ?? "");
  if (unit.stockBase === "each") {
    if (!Number.isInteger(amount)) return unknown;
    if (unit.eachLabel === EACH) {
      return { kind: "count", label: EACH, count: amount * count };
    }
    if (!isPackageWord(unit.eachLabel)) return unknown;
    return {
      kind: "package",
      label: unit.eachLabel,
      count: amount * count,
      size: null,
    };
  }
  const trailing = readStockUnit(rest.split(/\s+/).pop() ?? "").eachLabel;
  return {
    kind: "package",
    label:
      trailing !== null && isPackageWord(trailing) ? trailing : DEFAULT_PACKAGE,
    count,
    size: sizeDraft(
      Number(toStockAmount(amount, unit).toFixed(1)),
      unit.stockBase,
    ),
  };
}

/** Selects the chip when the draft is its kind of amount; pressing it then keeps the draft. */
function choice(label: string, draft: AmountDraft, seed: AmountDraft): Choice {
  const selected = sameChip(draft, seed);
  return { label, selected, draft: selected ? draft : seed };
}

function sameChip(a: AmountDraft, b: AmountDraft): boolean {
  switch (a.kind) {
    case "measure":
      return b.kind === "measure" && a.unit === b.unit;
    case "count":
      return b.kind === "count" && a.label === b.label;
    case "package":
      return b.kind === "package";
  }
}

function sizeDraft(amount: number, base: MeasuredBase): SizeDraft {
  const measured = toMeasure(amount, base);
  return { amount: String(measured.amount), unit: measured.unit };
}

function parsePositive(text: string): number | null {
  const value = parseDecimal(text.trim());
  return value > 0 ? value : null;
}

// Accepts a decimal comma, which iOS number pads type in many locales.
function parseDecimal(text: string): number {
  return /^\d*[.,]?\d*$/.test(text) && /\d/.test(text)
    ? Number(text.replace(",", "."))
    : NaN;
}

function wholeCount(value: number | null): number {
  return value !== null && Number.isInteger(value) && value >= 1 ? value : 1;
}

function isPackageWord(word: string): word is PackageWord {
  return (PACKAGE_WORDS as string[]).includes(word);
}
