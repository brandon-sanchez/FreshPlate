"""Recipe amounts are checked against inventory in compatible units (#72)."""

from __future__ import annotations

from decimal import Decimal
from typing import Any

import pytest

from app.ai.agents.models import Recipe
from app.ai.agents.nodes import check_quality
from app.ai.agents.units import inventory_amount, same_food


def _item(item_id: str, name: str, quantity: float, unit: str) -> dict[str, Any]:
    return {
        "id": item_id,
        "name": name,
        "quantity": quantity,
        "unit": unit,
        "expiration_date": None,
        "days_until_expiration": None,
        "is_expiring": False,
    }


def _recipe(*ingredients: tuple[str, str, float, str]) -> Recipe:
    return Recipe.model_validate(
        {
            "title": "Lemon Garlic Salmon",
            "cook_time_minutes": 25,
            "servings": 2,
            "ingredients": [
                {"name": name, "inventory_item_id": item_id, "use_amount": amount,
                 "unit": unit}
                for item_id, name, amount, unit in ingredients
            ],
            "steps": ["Sear the salmon.", "Finish with garlic and lemon."],
        }
    )


KITCHEN = [
    _item("salmon", "salmon fillets", 500, "g"),
    _item("garlic", "garlic", 1, "head"),
    _item("oil", "olive oil", 1, "l"),
    _item("lemons", "lemons", 3, "each"),
    _item("butter", "butter", 1, "Lb"),
    _item("yogurt", "Greek yogurt", 2, "Containers (150 g each)"),
    _item("salt", "kosher salt", 1, "container"),
]


@pytest.mark.parametrize(
    ("amount", "recipe_unit", "item_unit", "food", "expected"),
    [
        (15, "ml", "l", "olive oil", "0.015"),
        (2, "tbsp", "ml", "olive oil", "29.5735"),
        (1, "cup", "ml", "milk", "236.5882"),
        (8, "oz", "lb", "butter", "0.5"),
        (500, "g", "kg", "rice", "0.5"),
        (3, "cloves", "head", "garlic", "0.3"),
        (2, "Cups", "cup", "rice", "2"),
        (2, "cans", "Can", "black beans", "2"),
        (300, "g", "Containers (150 g each)", "yogurt", "2"),
        (1, "item", "each", "onion", "1"),
    ],
)
def test_compatible_units_convert_into_the_inventory_unit(
    amount, recipe_unit, item_unit, food, expected
) -> None:
    converted = inventory_amount(Decimal(amount), recipe_unit, item_unit, food)
    assert converted is not None
    assert converted.quantize(Decimal("0.0001")) == Decimal(expected)


@pytest.mark.parametrize(
    ("recipe_unit", "item_unit"),
    [("g", "ml"), ("cup", "g"), ("each", "head"), ("slice", "loaf"), ("g", "bag")],
)
def test_incompatible_units_do_not_convert(recipe_unit, item_unit) -> None:
    assert inventory_amount(Decimal(1), recipe_unit, item_unit, "bread") is None


@pytest.mark.parametrize(
    ("a", "b", "same"),
    [
        ("lemon", "lemons", True),
        ("Tomato", "tomatoes", True),
        ("cherry", "cherries", True),
        ("black bean", "Black Beans", True),
        ("bunch of radish", "radishes", False),
        ("shrimp", "tomatoes", False),
        ("cream", "creams", True),
        ("hummus", "hummus", True),
    ],
)
def test_food_names_match_across_singular_and_plural(a, b, same) -> None:
    assert same_food(a, b) is same


def test_realistic_recipe_passes_when_units_and_plurals_differ() -> None:
    recipe = _recipe(
        ("salmon", "salmon fillets", 400, "g"),
        ("garlic", "garlic", 3, "cloves"),
        ("oil", "olive oil", 2, "tbsp"),
        ("lemons", "lemon", 1, "each"),
        ("butter", "butter", 2, "tbsp"),
    )
    result = check_quality({"usable_items": KITCHEN, "generated_recipes": [recipe]})
    assert result["quality_feedback"] is not None
    assert "butter" in result["quality_feedback"]

    without_butter = recipe.model_copy(update={"ingredients": recipe.ingredients[:4]})
    result = check_quality(
        {"usable_items": KITCHEN, "generated_recipes": [without_butter]}
    )
    assert result == {"valid_recipes": [without_butter], "quality_feedback": None}


def test_more_than_the_kitchen_has_still_fails_after_conversion() -> None:
    recipe = _recipe(
        ("garlic", "garlic", 12, "cloves"),
        ("yogurt", "Greek yogurt", 400, "g"),
    )
    result = check_quality({"usable_items": KITCHEN, "generated_recipes": [recipe]})
    assert result["valid_recipes"] == []
    assert "'garlic' uses more than the available 1.0 head" in result[
        "quality_feedback"
    ]
    assert "'Greek yogurt' uses more than the available" in result["quality_feedback"]


def test_amounts_mapped_to_one_item_add_up_across_units() -> None:
    recipe = _recipe(
        ("oil", "olive oil", 800, "ml"),
        ("oil", "olive oil", 1, "cup"),
    )
    result = check_quality({"usable_items": KITCHEN, "generated_recipes": [recipe]})
    assert result["valid_recipes"] == []
    assert "use 1.037 l in total" in result["quality_feedback"]


def test_a_different_food_still_fails_even_with_a_matching_unit() -> None:
    recipe = _recipe(("salmon", "shrimp", 200, "g"))
    result = check_quality({"usable_items": KITCHEN, "generated_recipes": [recipe]})
    assert "does not match inventory item name" in result["quality_feedback"]
