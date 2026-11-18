"""Reject meals with no main component or too little food, before the judge.

These checks run in code on each grounded recipe, so a clear failure gets its
retry feedback without a meal-judge call. They only reject: a recipe they
pass still goes to the judge, which decides whether it is a real meal.
Weights come from the unit converter and the kitchen's food facts. When any
ingredient's weight is unknown, the checks pass the recipe on rather than
guess.
"""

from __future__ import annotations

from collections.abc import Sequence
from decimal import Decimal
from typing import Literal

from app.ai.agents.dish import RequestedDish
from app.ai.agents.diversity import CONDIMENT_AND_DRINK_CATEGORIES
from app.ai.agents.models import Recipe, RecipeIngredient
from app.ai.agents.state import UsableItem
from app.inventory.food_facts import FoodLine
from app.inventory.units import Approximate, Exact, FoodFacts, Small, to_stock

MEAL_MIN_MAIN_GRAMS_PER_SERVING = Decimal(40)
"""The least weight per serving of the foods that could be a meal's main.

Condiments, drinks and kitchen basics don't count. The other foods count
together, because a soup or a stir-fry spreads its substance across many
of them. Set below the smallest real main on its own: a large egg (50 g),
dry rice or lentils (45 to 75 g), or a small piece of meat (80 g). Dry
grains are weighed dry.
"""

MEAL_MIN_FOOD_GRAMS_PER_SERVING = Decimal(100)
"""The least food, kitchen basics included, a meal may hold per serving.

A full plate is 300 to 600 g. 100 g is under a light pasta made with dry
pasta (about 130 g), so only a token amount fails.
"""

# Kitchen basics have no food facts, and ``KitchenBasics.units`` measures
# them only by volume.
_BASIC_FACTS = FoodFacts(stock_base="ml")

PortionVerdict = Literal["wrong_dish", "insufficient"]
"""How a meal fails the portion checks, in the judge's verdict names."""


def meal_portion_issue(
    recipe: Recipe, usable_items: Sequence[UsableItem], dish: RequestedDish
) -> tuple[PortionVerdict, str] | None:
    """Return why ``recipe`` is clearly not a meal, or None to ask the judge.

    A meal fails as ``wrong_dish`` when its foods other than condiments,
    drinks and kitchen basics weigh under ``MEAL_MIN_MAIN_GRAMS_PER_SERVING``
    together, because nothing in it can be a main. It fails as ``insufficient``
    when all its ingredients together weigh under
    ``MEAL_MIN_FOOD_GRAMS_PER_SERVING`` per serving. A liquid with no known
    density is weighed as water, and a kitchen basic is measured in volume
    and weighed the same way.

    Args:
        recipe: A recipe that passed the inventory checks, so every
            ingredient is a usable food or a kitchen basic.
        usable_items: The kitchen's usable foods, with their facts.
        dish: The kind of dish the session asks for. Only a meal is checked.

    Returns:
        The verdict and a reason that goes back to the generator as retry
        feedback, or None when the recipe passes, isn't a meal, or has an
        ingredient whose weight is unknown.
    """
    if dish != "meal":
        return None
    foods = {item["id"]: FoodLine.model_validate(item["food"]) for item in usable_items}
    total = Decimal(0)
    main = Decimal(0)
    for ingredient in recipe.ingredients:
        food = foods.get(ingredient.inventory_item_id or "")
        grams = _grams(ingredient, None if food is None else food.facts)
        if grams is None:
            return None
        total += grams
        if food is not None and _can_be_main(food):
            main += grams

    servings = Decimal(recipe.servings)
    if main / servings < MEAL_MIN_MAIN_GRAMS_PER_SERVING:
        return (
            "wrong_dish",
            "no main component: the foods other than condiments, drinks and "
            f"kitchen basics weigh {_grams_text(main / servings)} per serving, "
            f"under the {MEAL_MIN_MAIN_GRAMS_PER_SERVING:f} g a meal needs",
        )
    if total / servings < MEAL_MIN_FOOD_GRAMS_PER_SERVING:
        return (
            "insufficient",
            f"about {_grams_text(total / servings)} of food per serving, under "
            f"the {MEAL_MIN_FOOD_GRAMS_PER_SERVING:f} g a meal needs",
        )
    return None


def _grams(ingredient: RecipeIngredient, facts: FoodFacts | None) -> Decimal | None:
    """Return the ingredient's weight, or None when it can't be known.

    ``facts`` is None for a kitchen basic, which is measured in volume.
    """
    if ingredient.use_amount is None:
        return None
    conversion = to_stock(
        Decimal(str(ingredient.use_amount)), ingredient.unit, facts or _BASIC_FACTS
    )
    if isinstance(conversion, Small):
        # Seasoning-sized amounts are in grams or millilitres already.
        return conversion.amount
    if not isinstance(conversion, Exact | Approximate):
        return None
    per_unit = _grams_per_stock_unit(facts or _BASIC_FACTS)
    return None if per_unit is None else conversion.amount * per_unit


def _grams_per_stock_unit(facts: FoodFacts) -> Decimal | None:
    if facts.stock_base == "g":
        return Decimal(1)
    one_gram = to_stock(Decimal(1), "g", facts)
    if isinstance(one_gram, Exact | Approximate) and one_gram.amount > 0:
        return 1 / one_gram.amount
    return Decimal(1) if facts.stock_base == "ml" else None


def _can_be_main(food: FoodLine) -> bool:
    category = (food.category or "").strip().casefold()
    return category not in CONDIMENT_AND_DRINK_CATEGORIES


def _grams_text(grams: Decimal) -> str:
    return f"{grams.quantize(Decimal(1)):f} g"
