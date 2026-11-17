"""Behavior tests for how the recipe pipeline holds a household's basics."""

from __future__ import annotations

from app.ai.agents.kitchen_basics import KitchenBasics
from app.ai.agents.models import RecipeIngredient


def _ingredient(name: str, inventory_item_id: str | None) -> RecipeIngredient:
    return RecipeIngredient(
        name=name, inventory_item_id=inventory_item_id, use_amount=1, unit="tsp"
    )


def test_basics_are_trimmed_and_listed_once_whatever_their_case() -> None:
    basics = KitchenBasics([" Salt ", "SALT", "  ", "olive  oil", "Olive Oil"])

    assert basics.names == ("Salt", "olive  oil")
    assert basics.has_name("salt")
    assert basics.has_name("OLIVE OIL")
    assert not basics.has_name("Chicken stock")


def test_an_ingredient_with_no_food_is_a_basic_only_when_the_household_has_basics():
    stock_on_the_water_label = _ingredient("Chicken stock", None)

    assert KitchenBasics(["Water"]).supplies(stock_on_the_water_label)
    assert not KitchenBasics(["Water"]).supplies(_ingredient("Water", "water-id"))
    assert not KitchenBasics(()).supplies(_ingredient("Water", None))


def test_a_tracked_food_is_never_also_a_free_basic() -> None:
    basics = KitchenBasics(["Salt", "Olive oil", "Water"])

    assert basics.without(["olive oil ", "Rice"]) == KitchenBasics(["Salt", "Water"])
