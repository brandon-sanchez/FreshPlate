import {
  formatIngredientAmount,
  formatIngredientName,
  readRecipeSteps,
} from "@/lib/recipe-format";
import type { RecipeIngredient } from "@/types/recipes";

function ingredient(
  name: string,
  use_amount: number,
  unit: string,
  extra: Partial<RecipeIngredient> = {},
): RecipeIngredient {
  return { name, inventory_item_id: "food", use_amount, unit, ...extra };
}

describe("formatIngredientAmount", () => {
  it.each([
    ["Garlic", 0.25, "head", "¼ head"],
    ["Salmon fillets", 2, "fillet", "2"],
    ["Lemons", 1, "each", "1"],
    ["Olive oil", 30.0, "ml", "30 ml"],
    ["Basmati rice", 200.4, "g", "200 g"],
    ["Garlic", 3, "clove", "3 cloves"],
    ["Rice", 1.5, "cup", "1½ cups"],
    ["Butter", 0.333, "tbsp", "⅓ tbsp"],
    ["Milk", 0.66, "cup", "⅔ cup"],
    ["Salt", 0.05, "tsp", "⅛ tsp"],
    ["Peaches", 2.97, "can", "3 cans"],
    ["Onions", 2, "head", "2 heads"],
    ["Garlic", 2, "cloves", "2 cloves"],
  ])("formats %s at %s %s as %s", (name, amount, unit, expected) => {
    expect(formatIngredientAmount(ingredient(name, amount, unit))).toBe(
      expected,
    );
  });

  it("uses the recipe's spoken amount when it has one", () => {
    expect(
      formatIngredientAmount(
        ingredient("Garlic", 0.25, "head", { display_amount: "3 cloves" }),
      ),
    ).toBe("3 cloves");
  });
});

describe("formatIngredientName", () => {
  it.each([
    ["Lemons", 1, "lemon", {}, "Lemon"],
    ["Chicken thighs", 1, "thigh", { display_amount: "1" }, "Chicken thigh"],
    ["Berries", 1, "each", {}, "Berry"],
    ["Lemons", 2, "lemon", {}, "Lemons"],
    ["Olive oil", 1, "tbsp", {}, "Olive oil"],
    ["Eggs", 1, "egg", { display_amount: "1 large" }, "Eggs"],
  ])("names %s at %s %s %j as %s", (name, amount, unit, extra, expected) => {
    expect(formatIngredientName(ingredient(name, amount, unit, extra))).toBe(expected);
  });
});

describe("readRecipeSteps", () => {
  it("reads string steps as instructions without copied step numbers", () => {
    expect(
      readRecipeSteps(["Step 1: Boil the pasta\nBoil until al dente.", "2. Serve"]),
    ).toEqual([
      { instruction: "Boil the pasta\nBoil until al dente.", uses: [] },
      { instruction: "Serve", uses: [] },
    ]);
  });

  it.each(["2 eggs go in last.", "2-inch pieces\nCut the carrots."])(
    "keeps the leading measurement in %j",
    (step) => {
      expect(readRecipeSteps([step])[0].instruction).toBe(step);
    },
  );

  it("reads structured steps as they are", () => {
    const step = {
      instruction: "Sear the salmon\nLay the fillets in skin-side down.",
      doneness_cue: "Flip when the skin releases on its own.",
      minutes: 5,
      why: "Moving the fish tears the skin.",
      uses: ["salmon"],
    };
    expect(readRecipeSteps([step])).toEqual([step]);
  });
});
