import {
  buildRecipeFeedSessionRequest,
  recipeFeedEndingCopy,
  buildRecipeSuggestionRequest,
  recipeContextLabel,
} from "@/lib/recipes";

describe("recipe request helpers", () => {
  it("counts the usable ingredients when no answers were given", () => {
    expect(recipeContextLabel(12, {})).toBe("From your 12 ingredients");
    expect(recipeContextLabel(1, {})).toBe("From your 1 ingredient");
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

describe("recipeFeedEndingCopy", () => {
  it("ends a feed that still shows recipes", () => {
    expect(recipeFeedEndingCopy({ kind: "showing" }).title).toBe(
      "That's all for now",
    );
  });

  it("says the cook has seen every recipe after dismissing them all", () => {
    expect(recipeFeedEndingCopy({ kind: "dismissed" })).toEqual({
      title: "You've seen them all",
      message:
        "You've passed on every recipe in this set. Add ingredients or edit your answers for a fresh set.",
    });
  });

  it.each([
    [undefined, "a protein, pasta or rice"],
    ["None", "a protein, pasta or rice"],
    ["Vegan", "beans, tofu, lentils or pasta"],
    ["Vegetarian", "eggs, beans, tofu or pasta"],
    ["Keto", "meat, fish, eggs or cheese"],
    ["Gluten-free", "a protein, rice or potatoes"],
    ["High protein", "chicken, fish, eggs, beans or tofu"],
  ])("suggests a main that fits the %s diet", (diet, suggestion) => {
    expect(recipeFeedEndingCopy({ kind: "empty", dish: "meal" }, diet)).toEqual({
      title: "Not enough for a full meal",
      message: `Add a main to build a meal around, such as ${suggestion}, or change your answers.`,
    });
  });

  it.each([
    ["snack", "Not enough for a snack"],
    ["dessert", "Not enough for a dessert"],
  ] as const)("names the %s the kitchen couldn't make", (dish, title) => {
    expect(recipeFeedEndingCopy({ kind: "empty", dish }).title).toBe(title);
  });
});
