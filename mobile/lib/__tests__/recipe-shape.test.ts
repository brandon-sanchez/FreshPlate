import { hasReadableCookbookFields, isRecipeStep } from "@/lib/recipe-shape";

describe("isRecipeStep", () => {
  it("accepts both step shapes and rejects blank or malformed steps", () => {
    expect(isRecipeStep("Boil the pasta.")).toBe(true);
    expect(isRecipeStep({ instruction: "Boil.", uses: ["pasta"] })).toBe(true);
    expect(
      isRecipeStep({ instruction: "Boil.", doneness_cue: null, minutes: null }),
    ).toBe(true);
    expect(isRecipeStep(" ")).toBe(false);
    expect(isRecipeStep({ instruction: "" })).toBe(false);
    expect(isRecipeStep({ instruction: "Boil.", uses: [3] })).toBe(false);
    expect(isRecipeStep({ instruction: "Boil.", minutes: "5" })).toBe(false);
  });
});

describe("hasReadableCookbookFields", () => {
  const ingredient = { name: "Garlic", use_amount: 3, unit: "clove" };

  it("accepts string-step recipes and well-typed cookbook fields", () => {
    expect(hasReadableCookbookFields({ ingredients: [ingredient] })).toBe(true);
    expect(
      hasReadableCookbookFields({
        headnote: "Quick.",
        active_minutes: 10,
        total_minutes: null,
        equipment: ["skillet"],
        ingredients: [{ ...ingredient, prep: "minced", display_amount: "3 cloves" }],
      }),
    ).toBe(true);
  });

  it.each([
    { headnote: 3 },
    { equipment: "skillet" },
    { total_minutes: "25" },
    { ingredients: [{ ...ingredient, display_amount: 3 }] },
  ])("rejects a field the app cannot read: %j", (fields) => {
    expect(
      hasReadableCookbookFields({ ingredients: [ingredient], ...fields }),
    ).toBe(false);
  });
});
