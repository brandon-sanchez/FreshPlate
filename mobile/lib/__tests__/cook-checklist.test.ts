import {
  addedLine,
  confirmationBody,
  linesFromPlan,
  matchAddable,
  reloadLines,
  shortfallNote,
  stepAmount,
} from "@/lib/cook-checklist";
import type { CookPlan, CookPlanFood, CookPlanLine } from "@/types/cook";
import type { ActiveCook } from "@/stores/activeCook";

const planLine = (
  line: number,
  mode: CookPlanLine["mode"],
  stock_amount: number | null,
  ingredient = "Eggs",
): CookPlanLine => ({
  line,
  ingredient,
  recipe_amount: 2,
  recipe_unit: "egg",
  mode,
  stock_amount,
});

const food = (overrides: Partial<CookPlanFood>): CookPlanFood => ({
  food_id: "eggs",
  name: "Eggs",
  stock_base: "each",
  each_label: "egg",
  whole_units_only: true,
  available: 6,
  draw: 2,
  estimated: false,
  rounding_note: null,
  lines: [planLine(0, "draw", 2)],
  ...overrides,
});

const plan = (...foods: CookPlanFood[]): CookPlan => ({ foods, untracked: [] });

const cook = {
  userId: "u1",
  householdId: "h1",
  operationId: "op1",
  recipe: { recipe_id: "r1", title: "Shakshuka" },
} as unknown as ActiveCook;

describe("linesFromPlan", () => {
  it("pre-fills each food with the amount the recipe takes", () => {
    const [line] = linesFromPlan(plan(food({ draw: 3, available: 4 })));

    expect(line).toMatchObject({
      foodId: "eggs",
      name: "Eggs",
      unit: "egg",
      amount: 3,
      available: 4,
      changed: null,
    });
  });
});

describe("confirmationBody", () => {
  it("deducts each used food and expects stock to cover what the checklist showed", () => {
    const [eggs, milk] = linesFromPlan(
      plan(
        food({ draw: 2, available: 6 }),
        food({
          food_id: "milk",
          name: "Milk",
          stock_base: "ml",
          each_label: null,
          whole_units_only: false,
          available: 150,
          draw: 250,
          lines: [planLine(1, "draw", 250, "Milk")],
        }),
      ),
    );

    const body = confirmationBody(cook, [eggs, milk]);

    expect(body).toEqual({
      household_id: "h1",
      operation_id: "op1",
      recipe_id: "r1",
      recipe_snapshot: cook.recipe,
      deductions: [
        { inventory_item_id: "eggs", confirmed_amount: 2, expected_amount: 2 },
        { inventory_item_id: "milk", confirmed_amount: 250, expected_amount: 150 },
      ],
      lines: [
        {
          ingredient: "Eggs",
          inventory_item_id: "eggs",
          recipe_amount: 2,
          recipe_unit: "egg",
          mode: "draw",
          stock_amount: 2,
        },
        {
          ingredient: "Milk",
          inventory_item_id: "milk",
          recipe_amount: 2,
          recipe_unit: "egg",
          mode: "draw",
          stock_amount: 250,
        },
      ],
    });
  });

  it("leaves out a food set to zero, lines and all", () => {
    const [eggs] = linesFromPlan(plan(food({})));

    const body = confirmationBody(cook, [{ ...eggs, amount: 0 }]);

    expect(body.deductions).toEqual([]);
    expect(body.lines).toEqual([]);
  });

  it("gives what the converted lines don't cover to the first question", () => {
    const [oil] = linesFromPlan(
      plan(
        food({
          food_id: "oil",
          stock_base: "ml",
          each_label: null,
          whole_units_only: false,
          available: 500,
          draw: 30,
          lines: [planLine(0, "ask", null), planLine(1, "draw", 30), planLine(2, "ask", null)],
        }),
      ),
    );

    const body = confirmationBody(cook, [{ ...oil, amount: 45 }]);

    expect(body.lines.map((l) => [l.mode, l.stock_amount])).toEqual([
      ["ask", 15],
      ["draw", 30],
      ["ask", null],
    ]);
  });

  it("answers a seasoning-only food raised above zero as a question", () => {
    const [salt] = linesFromPlan(
      plan(
        food({
          food_id: "salt",
          each_label: "container",
          whole_units_only: false,
          draw: 0,
          lines: [planLine(0, "small", null), planLine(3, "small", null)],
        }),
      ),
    );

    const body = confirmationBody(cook, [{ ...salt, amount: 0.25 }]);

    expect(body.deductions).toEqual([
      { inventory_item_id: "salt", confirmed_amount: 0.25, expected_amount: 0.25 },
    ]);
    expect(body.lines.map((l) => [l.mode, l.stock_amount])).toEqual([
      ["ask", 0.25],
      ["small", null],
    ]);
  });

  it("records an added item as a line in its stock unit", () => {
    const rice = addedLine({
      foodId: "rice",
      name: "Rice",
      stockBase: "g",
      unit: "g",
      available: 400,
      wholeUnitsOnly: false,
      subUnit: null,
    });

    const body = confirmationBody(cook, [{ ...rice, amount: 100 }]);

    expect(body.deductions).toEqual([
      { inventory_item_id: "rice", confirmed_amount: 100, expected_amount: 100 },
    ]);
    expect(body.lines).toEqual([
      {
        ingredient: "Rice",
        inventory_item_id: "rice",
        recipe_amount: 100,
        recipe_unit: "g",
        mode: "draw",
        stock_amount: 100,
      },
    ]);
  });
});

describe("step", () => {
  it("counts whole-unit foods one at a time and never below zero", () => {
    const [eggs] = linesFromPlan(plan(food({ draw: 1 })));

    expect(stepAmount(eggs, 1)).toBe(2);
    expect(stepAmount({ ...eggs, amount: 0 }, -1)).toBe(0);
  });

  it("snaps weights and volumes to round numbers", () => {
    const [oil] = linesFromPlan(
      plan(food({ stock_base: "ml", each_label: null, whole_units_only: false, draw: 34.5 })),
    );

    expect(stepAmount(oil, 1)).toBe(35);
    expect(stepAmount(oil, -1)).toBe(30);
    expect(stepAmount({ ...oil, amount: 450 }, 1)).toBe(475);
    expect(stepAmount({ ...oil, amount: 1500 }, -1)).toBe(1400);
  });

  it("steps counted foods that can be split by a quarter", () => {
    const [garlic] = linesFromPlan(
      plan(food({ each_label: "head", whole_units_only: false, draw: 0.225 })),
    );

    expect(stepAmount(garlic, 1)).toBe(0.25);
    expect(stepAmount(garlic, -1)).toBe(0);
  });

  it("steps a counted food with a smaller unit one smaller unit at a time", () => {
    const [garlic] = linesFromPlan(
      plan(food({ each_label: "head", whole_units_only: false, draw: 0.2 })),
    );
    const cloves = { ...garlic, subUnit: { label: "clove", perUnit: 0.1 } };

    expect(stepAmount(cloves, 1)).toBe(0.3);
    expect(stepAmount(cloves, -1)).toBe(0.1);
    expect(stepAmount({ ...cloves, amount: 0.3 }, 1)).toBe(0.4);
    expect(stepAmount({ ...cloves, amount: 0.7 }, -1)).toBe(0.6);
  });
});

describe("reloadLines", () => {
  it("marks each line whose stock fell below what it expected and keeps the amounts", () => {
    const lines = [
      ...linesFromPlan(
        plan(
          food({ draw: 3, available: 6 }),
          food({ food_id: "milk", name: "Milk", stock_base: "ml", each_label: null, available: 500, draw: 200 }),
        ),
      ),
      addedLine({ foodId: "rice", name: "Rice", stockBase: "g", unit: "g", available: 400, wholeUnitsOnly: false, subUnit: null }),
    ];

    const reloaded = reloadLines(
      lines,
      plan(food({ draw: 3, available: 2 }), food({ food_id: "milk", available: 450, stock_base: "ml" })),
      new Map([["rice", 0]]),
    );

    expect(reloaded.map((l) => [l.foodId, l.amount, l.available, l.changed])).toEqual([
      ["eggs", 3, 2, "Only 2 eggs left now"],
      ["milk", 200, 450, null],
      ["rice", 5, 0, "None left now"],
    ]);
  });

  it("reads a food the new plan no longer lists as out of stock", () => {
    const lines = linesFromPlan(plan(food({ draw: 1 })));

    const [eggs] = reloadLines(lines, plan(), new Map());

    expect([eggs.available, eggs.changed]).toEqual([0, "None left now"]);
  });
});

describe("shortfallNote", () => {
  it("says how much comes off when the amount used is more than the stock", () => {
    const [chicken] = linesFromPlan(
      plan(food({ stock_base: "g", each_label: null, whole_units_only: false, available: 230, draw: 425 })),
    );

    expect(shortfallNote(chicken)).toBe("More than the 230 g you have");
    expect(shortfallNote({ ...chicken, available: 0 })).toBe("None left to deduct");
  });

  it("says nothing when the stock covers the amount", () => {
    const [eggs] = linesFromPlan(plan(food({ draw: 6, available: 6 })));

    expect(shortfallNote(eggs)).toBeNull();
  });
});

describe("Add item", () => {
  it("matches name and word starts, skips listed foods, and stops at five", () => {
    const names = ["Milk", "Oat milk", "Millet", "Almond milk", "Milkshake mix", "Mild salsa", "Soy milk", "Chamomile"];
    const foods = names.map((name) => ({ foodId: name, name, stockBase: "ml" as const, unit: "ml", available: 1, wholeUnitsOnly: false, subUnit: null }));

    expect(matchAddable(foods, " mil", new Set(["Milk"])).map((f) => f.name)).toEqual([
      "Millet",
      "Milkshake mix",
      "Mild salsa",
      "Oat milk",
      "Almond milk",
    ]);
    expect(matchAddable(foods, "  ", new Set())).toEqual([]);
  });
});
