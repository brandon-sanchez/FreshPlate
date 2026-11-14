import {
  buildRecipeFeedSessionRequest,
  buildRecipeSuggestionRequest,
  recipeContextLabel,
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

  it("sends the household instead of an inventory snapshot", () => {
    const preferences = { meal: "Dinner" as const };

    expect(buildRecipeSuggestionRequest("household-1", preferences)).toEqual({
      household_id: "household-1",
      preferences,
      exclude_titles: [],
      batch_ceiling: 8,
    });
    expect(buildRecipeFeedSessionRequest("household-1", preferences)).toEqual({
      household_id: "household-1",
      preferences,
    });
  });
});
