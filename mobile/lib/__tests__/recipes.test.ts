import {
  buildRecipeSuggestionRequest,
  recipeContextLabel,
  toRecipeInventoryContext,
} from "@/lib/recipes";

describe("recipe request helpers", () => {
  it("uses the inventory-only context copy when no answers were given", () => {
    expect(recipeContextLabel(12, {})).toBe("From your 12 items");
  });

  it("summarizes answered session preferences without persisting anything", () => {
    expect(
      recipeContextLabel(12, { meal: "Dinner", occasion: "date night" }),
    ).toBe("Tuned · 2 preferences");
  });

  it("maps only the inventory fields accepted by the generation request", () => {
    const items = [
      {
        id: "spinach",
        name: "Baby Spinach",
        quantity: 1,
        unit: "bag",
        expiration_date: "2026-08-06",
        storage_location: "fridge" as const,
        is_leftover: false,
        notes: "wash first",
        added_by: "user-1",
        category: null,
      },
    ];
    const preferences = { meal: "Dinner" as const };

    expect(toRecipeInventoryContext(items)).toEqual([
      {
        id: "spinach",
        name: "Baby Spinach",
        quantity: 1,
        unit: "bag",
        expiration_date: "2026-08-06",
      },
    ]);
    expect(buildRecipeSuggestionRequest(items, preferences)).toEqual({
      inventory: [
        {
          id: "spinach",
          name: "Baby Spinach",
          quantity: 1,
          unit: "bag",
          expiration_date: "2026-08-06",
        },
      ],
      preferences,
      exclude_titles: [],
      batch_ceiling: 8,
    });
  });
});
