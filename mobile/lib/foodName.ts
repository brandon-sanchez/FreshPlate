import type { InventoryItem } from "@/hooks/useInventoryItems";

/**
 * Returns a food name's duplicate-detection key: lowercase, trimmed, with each
 * run of whitespace collapsed to one space. Mirrors `public.food_name_key`, so
 * "  horchata " and "Horchata" name the same food.
 */
export function foodNameKey(name: string): string {
  return name.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Returns the batches of the food called `name`, the ones food typed under
 * that name can be added into. Returns none for a blank name.
 */
export function batchesOfFoodNamed(
  name: string,
  lots: readonly InventoryItem[],
): InventoryItem[] {
  const key = foodNameKey(name);
  return key === "" ? [] : lots.filter((lot) => foodNameKey(lot.name) === key);
}
