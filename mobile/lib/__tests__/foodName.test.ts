import type { InventoryItem } from "@/hooks/useInventoryItems";
import { batchesOfFoodNamed, foodNameKey } from "@/lib/foodName";

it("keys names the way public.food_name_key does", () => {
  expect(foodNameKey("  Green \t  ONIONS ")).toBe("green onions");
});

it("finds the batches of the food a typed name refers to", () => {
  const lots = [
    { id: "a", name: "Horchata" },
    { id: "b", name: "Milk" },
    { id: "c", name: "Horchata" },
  ] as InventoryItem[];

  expect(batchesOfFoodNamed(" horchata", lots).map((lot) => lot.id)).toEqual(["a", "c"]);
  expect(batchesOfFoodNamed("   ", lots)).toEqual([]);
});
