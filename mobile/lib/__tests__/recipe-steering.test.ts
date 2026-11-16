import {
  areRecipesSimilar,
  keepSteeredCards,
  planSteerSweep,
  steeringRequest,
  type SteerSignal,
} from "@/lib/recipe-steering";
import type { RecipeSuggestion } from "@/types/recipes";

function recipe(id: string, foods: string[]): RecipeSuggestion {
  return {
    recipe_id: id,
    title: id,
    cook_time_minutes: 20,
    servings: 2,
    ingredients: foods.map((food) => ({
      name: food,
      inventory_item_id: food,
      use_amount: 1,
      unit: "each",
    })),
    steps: ["Cook."],
    match_percent: 100,
    saves_expiring: [],
  };
}

const salmonRice = recipe("salmon-rice", [
  "salmon",
  "rice",
  "peas",
  "lemon",
  "oil",
  "garlic",
]);
const salmonPeas = recipe("salmon-peas", [
  "salmon",
  "rice",
  "peas",
  "garlic",
  "lemon",
  "oil",
]);
const friedRice = recipe("fried-rice", [
  "rice",
  "eggs",
  "carrots",
  "peas",
  "soy",
  "oil",
]);
const chickpeaStew = recipe("chickpea-stew", [
  "chickpeas",
  "tomatoes",
  "carrots",
  "garlic",
  "oil",
  "lemon",
]);
const chickpeaPasta = recipe("chickpea-pasta", [
  "spaghetti",
  "chickpeas",
  "tomatoes",
  "carrots",
  "garlic",
  "oil",
  "parmesan",
]);

describe("areRecipesSimilar", () => {
  it("counts two recipes alike when half the foods they use between them are shared", () => {
    expect(areRecipesSimilar(chickpeaStew, chickpeaPasta)).toBe(true);
    expect(areRecipesSimilar(salmonRice, salmonPeas)).toBe(true);
  });

  it("doesn't count staples alone as likeness", () => {
    expect(areRecipesSimilar(salmonRice, friedRice)).toBe(false);
  });

  it("needs at least two shared foods", () => {
    const toast = recipe("toast", ["bread"]);
    const jam = recipe("jam", ["bread", "jam"]);

    expect(areRecipesSimilar(toast, jam)).toBe(false);
  });

  it("matches untracked ingredients by name, ignoring case and spacing", () => {
    const a = recipe("a", ["eggs"]);
    a.ingredients.push({
      name: "Sea  Salt",
      inventory_item_id: null,
      use_amount: 1,
      unit: "pinch",
    });
    const b = recipe("b", ["eggs"]);
    b.ingredients.push({
      name: "sea salt",
      inventory_item_id: null,
      use_amount: 1,
      unit: "pinch",
    });

    expect(areRecipesSimilar(a, b)).toBe(true);
  });
});

describe("planSteerSweep", () => {
  const feed = [friedRice, salmonRice, chickpeaStew, salmonPeas, chickpeaPasta];

  it("sweeps the dissimilar cards below for More like this and keeps similar ones", () => {
    expect(planSteerSweep(feed, "salmon-rice", "more")).toEqual([
      "chickpea-stew",
      "chickpea-pasta",
    ]);
  });

  it("sweeps the card and the similar cards below for Less like this", () => {
    expect(planSteerSweep(feed, "chickpea-stew", "less")).toEqual([
      "chickpea-stew",
      "chickpea-pasta",
    ]);
  });

  it("never sweeps cards above the chosen one", () => {
    const above = recipe("above", [
      "chickpeas",
      "tomatoes",
      "carrots",
      "garlic",
      "oil",
    ]);

    expect(
      planSteerSweep([above, ...feed], "salmon-rice", "more"),
    ).not.toContain("above");
    expect(
      planSteerSweep([above, ...feed], "chickpea-stew", "less"),
    ).not.toContain("above");
  });

  it("sweeps nothing when the card is no longer in the feed", () => {
    expect(planSteerSweep(feed, "gone", "less")).toEqual([]);
  });
});

describe("steeringRequest", () => {
  it("sends nothing before the first pick", () => {
    expect(steeringRequest([])).toBeUndefined();
  });

  it("sends the most recent picks within the backend's limits", () => {
    const signals: SteerSignal[] = Array.from({ length: 12 }, (_, index) => ({
      direction: index % 3 === 0 ? "more" : "less",
      recipe: recipe(`r${index}`, ["eggs"]),
    }));

    expect(steeringRequest(signals)).toEqual({
      more_like: ["r3", "r6", "r9"],
      less_like: ["r1", "r2", "r4", "r5", "r7", "r8", "r10", "r11"],
    });
  });
});

describe("keepSteeredCards", () => {
  const lessStew: SteerSignal = { direction: "less", recipe: chickpeaStew };
  const moreSalmon: SteerSignal = { direction: "more", recipe: salmonRice };

  it("drops arriving cards alike to a Less like this pick", () => {
    expect(
      keepSteeredCards([chickpeaPasta, salmonPeas], [lessStew], [lessStew]),
    ).toEqual([salmonPeas]);
  });

  it("lets a later More like this pick override an alike Less pick", () => {
    const moreStew: SteerSignal = { direction: "more", recipe: chickpeaPasta };
    const signals = [lessStew, moreStew];

    expect(keepSteeredCards([chickpeaPasta], signals, signals)).toEqual([
      chickpeaPasta,
    ]);
  });

  it("keeps only alike cards when More like this came after the request", () => {
    expect(
      keepSteeredCards([chickpeaPasta, salmonPeas], [moreSalmon], []),
    ).toEqual([salmonPeas]);
  });
});
