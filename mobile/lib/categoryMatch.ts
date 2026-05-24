import { FoodCategory, StorageLocation } from "@/hooks/useFoodCategories";

type Bucket = {
  label: string;
  needles: string[];
};

/* Order matters: "Frozen" must precede "Meat & Seafood" / "Produce" so a frozen
 * item isn't claimed by its base ingredient (frozen-pizza, frozen-vegetables).
 * Labels match food_categories.name exactly (case-insensitive). */
const BUCKETS: Bucket[] = [
  { label: "Frozen", needles: ["frozen"] },
  { label: "Meat & Seafood", needles: ["seafood", "fish", "salmon", "tuna", "shrimp", "prawn", "meat", "poultry", "beef", "chicken", "pork", "sausage", "bacon", "ham", "turkey"] },
  { label: "Dairy & Eggs", needles: ["dairy", "milk", "cheese", "yogurt", "yoghurt", "butter", "cream", "egg"] },
  { label: "Grains & Bread", needles: ["bread", "bakery", "pastry", "bagel", "tortilla", "biscuit", "grain", "cereal", "rice", "pasta", "oat", "quinoa", "noodle"] },
  { label: "Beverages", needles: ["beverage", "drink", "soda", "juice", "water", "coffee", "tea"] },
  { label: "Produce", needles: ["fruit", "vegetable", "produce", "berries", "salad", "herb"] },
  { label: "Condiments", needles: ["sauce", "condiment", "dressing", "spread", "mustard", "ketchup", "mayonnaise"] },
  { label: "Snacks", needles: ["snack", "chip", "cracker", "candy", "chocolate", "cookie", "dessert", "confection"] },
  { label: "Canned Goods", needles: ["canned", "tinned", "preserved"] },
];

export function matchCategory(
  offTags: string[],
  categories: FoodCategory[] | undefined,
): FoodCategory | null {
  if (!categories || categories.length === 0) return null;
  if (!offTags || offTags.length === 0) return null;

  const byName = new Map(categories.map((c) => [c.name.toLowerCase(), c]));

  for (const tag of offTags) {
    const lower = tag.toLowerCase();
    for (const bucket of BUCKETS) {
      if (bucket.needles.some((needle) => lower.includes(needle))) {
        const hit = byName.get(bucket.label.toLowerCase());
        if (hit) return hit;
      }
    }
  }

  return null;
}

/* Hand-encoded defaults. Pure-data heuristics (first non-null, longest shelf
 * life) diverge from real-world habit — e.g. cans live in the pantry even
 * though `fridge_days` is also set. */
const STORAGE_BY_CATEGORY: Record<string, StorageLocation> = {
  "Dairy & Eggs": "fridge",
  "Meat & Seafood": "fridge",
  "Produce": "fridge",
  "Beverages": "fridge",
  "Condiments": "fridge",
  "Leftovers": "fridge",
  "Canned Goods": "pantry",
  "Grains & Bread": "pantry",
  "Snacks": "pantry",
  "Frozen": "freezer",
  "Other": "fridge",
};

function daysFor(category: FoodCategory, storage: StorageLocation): number | null {
  if (storage === "fridge") return category.fridge_days;
  if (storage === "freezer") return category.freezer_days;
  return category.pantry_days;
}

export function defaultStorageForCategory(
  category: FoodCategory | null | undefined,
): StorageLocation {
  if (!category) return "fridge";
  const preferred = STORAGE_BY_CATEGORY[category.name];
  if (preferred && daysFor(category, preferred) !== null) return preferred;
  if (category.fridge_days !== null) return "fridge";
  if (category.pantry_days !== null) return "pantry";
  if (category.freezer_days !== null) return "freezer";
  return "fridge";
}

/* Parses messy OFF quantity strings ("1L", "500 g", "17.6 oz tub"). Captures
 * the leading number + first unit token; trailing words ("tub", "pack of 6")
 * are dropped. */
const QUANTITY_PATTERN = /^([\d]+(?:[.,]\d+)?)\s*([a-zA-Z]+)?/;

export function parseQuantity(
  raw: string | null | undefined,
): { quantity: number; unit: string } | null {
  if (!raw) return null;
  const match = raw.trim().match(QUANTITY_PATTERN);
  if (!match) return null;
  const [, numStr, unitStr] = match;
  const normalised = numStr.replace(",", ".");
  const value = parseFloat(normalised);
  if (!Number.isFinite(value) || value <= 0) return null;
  return { quantity: value, unit: unitStr?.toLowerCase() ?? "item" };
}
