"""Behavior of the code checks that reject clear non-meals before the judge."""

from __future__ import annotations

from typing import Any

import pytest

from app.ai.agents.kitchen_basics import KitchenBasics
from app.ai.agents.models import Recipe
from app.ai.agents.nodes import analyze_inventory
from app.ai.agents.portions import (
    MEAL_MIN_FOOD_GRAMS_PER_SERVING,
    MEAL_MIN_MAIN_GRAMS_PER_SERVING,
    meal_portion_issue,
)

KITCHEN = [
    {
        "id": "chicken",
        "name": "Chicken thighs",
        "available": 2000,
        "stock_base": "g",
        "category": "Meat & Seafood",
    },
    {
        "id": "spinach",
        "name": "Spinach",
        "available": 500,
        "stock_base": "g",
        "category": "Produce",
    },
    {
        "id": "parsley",
        "name": "Parsley",
        "available": 200,
        "stock_base": "g",
        "category": "Produce",
    },
    {
        "id": "scallions",
        "name": "Scallions",
        "available": 200,
        "stock_base": "g",
        "category": "Produce",
    },
    {
        "id": "lemon",
        "name": "Lemon",
        "available": 4,
        "stock_base": "each",
        "each_label": "each",
        "category": "Produce",
        "profile_key": "lemon",
        "profile_unit_grams": {"each": 100},
    },
    {
        "id": "ketchup",
        "name": "Ketchup",
        "available": 1000,
        "stock_base": "ml",
        "category": "Condiments",
    },
    {
        "id": "stock",
        "name": "Chicken stock",
        "available": 2000,
        "stock_base": "ml",
        "g_per_ml": 1.0,
        "category": "Canned Goods",
    },
    {
        "id": "milk",
        "name": "Milk",
        "available": 2000,
        "stock_base": "ml",
        "category": "Dairy & Eggs",
    },
    {
        "id": "beans",
        "name": "Black beans",
        "available": 3,
        "stock_base": "each",
        "each_label": "can",
        "category": "Canned Goods",
    },
]
BASICS = KitchenBasics(("Salt", "Water"))
ITEMS = analyze_inventory({"inventory": KITCHEN, "kitchen_basics": BASICS})[
    "usable_items"
]


def _recipe(*ingredients: tuple[str | None, float, str], servings: int = 2) -> Recipe:
    return Recipe.model_validate(
        {
            "title": "Fixture dish",
            "cook_time_minutes": 20,
            "servings": servings,
            "ingredients": [
                {
                    "name": food or "Salt",
                    "inventory_item_id": food,
                    "use_amount": amount,
                    "unit": unit,
                }
                for food, amount, unit in ingredients
            ],
            "steps": ["Cook it."],
        }
    )


def _issue(recipe: Recipe, dish: str = "meal") -> tuple[str, str] | None:
    return meal_portion_issue(recipe, ITEMS, dish)


def test_thresholds_are_well_under_a_real_meal() -> None:
    assert MEAL_MIN_MAIN_GRAMS_PER_SERVING == 40
    assert MEAL_MIN_FOOD_GRAMS_PER_SERVING == 100


def test_a_substantial_meal_passes() -> None:
    recipe = _recipe(("chicken", 400, "g"), ("spinach", 150, "g"), (None, 1, "tsp"))

    assert _issue(recipe) is None


def test_a_meal_with_no_main_component_is_the_wrong_dish() -> None:
    garnish_plate = _recipe(
        ("parsley", 30, "g"),
        ("scallions", 20, "g"),
        ("lemon", 0.25, "each"),
        ("ketchup", 200, "ml"),
    )

    verdict, reason = _issue(garnish_plate)

    assert verdict == "wrong_dish"
    assert "no main component" in reason
    assert "weigh 38 g per serving" in reason


def test_a_condiment_never_counts_as_the_main_component() -> None:
    recipe = _recipe(("ketchup", 400, "ml"), ("spinach", 60, "g"))

    assert _issue(recipe)[0] == "wrong_dish"


def test_a_soup_spread_across_many_foods_has_a_main_component() -> None:
    minestrone = _recipe(
        ("spinach", 200, "g"),
        ("scallions", 150, "g"),
        ("parsley", 50, "g"),
        ("stock", 600, "ml"),
        (None, 4, "cup"),
        servings=6,
    )

    assert _issue(minestrone) is None


def test_one_food_written_on_two_lines_counts_once_in_full() -> None:
    recipe = _recipe(("chicken", 50, "g"), ("chicken", 50, "g"), servings=2)

    assert _issue(recipe)[0] == "insufficient"


def test_an_under_portioned_meal_is_insufficient() -> None:
    recipe = _recipe(("chicken", 120, "g"), ("spinach", 40, "g"), servings=2)

    verdict, reason = _issue(recipe)

    assert verdict == "insufficient"
    assert "80 g of food per serving" in reason


def test_a_meal_at_the_food_floor_passes() -> None:
    recipe = _recipe(("chicken", 160, "g"), ("spinach", 40, "g"), servings=2)

    assert _issue(recipe) is None


def test_kitchen_basics_count_toward_the_food_but_never_as_the_main() -> None:
    watery_side = _recipe(("spinach", 60, "g"), (None, 2, "cup"), servings=2)

    assert _issue(watery_side)[0] == "wrong_dish"


def test_a_liquid_with_no_known_density_is_weighed_as_water() -> None:
    recipe = _recipe(("milk", 60, "ml"), ("spinach", 20, "g"), servings=2)

    verdict, reason = _issue(recipe)

    assert verdict == "insufficient"
    assert "about 40 g of food per serving" in reason


def test_a_food_of_unknown_weight_leaves_the_decision_to_the_judge() -> None:
    recipe = _recipe(("beans", 1, "can"), ("spinach", 20, "g"), servings=2)

    assert _issue(recipe) is None


@pytest.mark.parametrize("dish", ["snack", "dessert"])
def test_snacks_and_desserts_are_never_checked(dish: Any) -> None:
    recipe = _recipe(("spinach", 20, "g"))

    assert _issue(recipe, dish) is None


def test_a_meal_of_only_condiments_and_basics_has_no_main_component() -> None:
    recipe = _recipe(("ketchup", 300, "ml"), (None, 1, "cup"))

    verdict, reason = _issue(recipe)

    assert verdict == "wrong_dish"
    assert "weigh 0 g per serving" in reason
