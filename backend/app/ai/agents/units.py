"""Compare recipe amounts with inventory amounts across units and plurals.

Kitchens store food in package units (a head of garlic, a litre of oil) while
recipes use cooking units (cloves, tablespoons). These helpers convert a recipe
amount into the inventory item's own unit when the two measure the same thing,
and return ``None`` when they do not, so the caller can reject the ingredient
instead of guessing.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from decimal import Decimal
from typing import Literal

Dimension = Literal["mass", "volume", "count"]

# Each unit's size in grams or millilitres.
_MASS = {
    "g": Decimal("1"),
    "gram": Decimal("1"),
    "kg": Decimal("1000"),
    "kilogram": Decimal("1000"),
    "oz": Decimal("28.349523125"),
    "ounce": Decimal("28.349523125"),
    "lb": Decimal("453.59237"),
    "pound": Decimal("453.59237"),
}
_VOLUME = {
    "ml": Decimal("1"),
    "milliliter": Decimal("1"),
    "millilitre": Decimal("1"),
    "l": Decimal("1000"),
    "liter": Decimal("1000"),
    "litre": Decimal("1000"),
    "tsp": Decimal("4.92892159375"),
    "teaspoon": Decimal("4.92892159375"),
    "tbsp": Decimal("14.78676478125"),
    "tablespoon": Decimal("14.78676478125"),
    "fl oz": Decimal("29.5735295625"),
    "cup": Decimal("236.5882365"),
    "pint": Decimal("473.176473"),
    "quart": Decimal("946.352946"),
    "gallon": Decimal("3785.411784"),
}
_COUNT_ALIASES = {
    "": "each",
    "item": "each",
    "piece": "each",
    "whole": "each",
    "ea": "each",
    "ct": "each",
    "count": "each",
}
# Count units that hold a known number of a smaller count unit of one food.
_FOOD_COUNTS = {("garlic", "head"): ("clove", Decimal("10"))}

_PACKAGE_SIZE = re.compile(
    r"^(?P<unit>.*?)\s*\(\s*(?P<size>\d+(?:\.\d+)?)\s*(?P<inner>[^\d()]+?)\s+each\s*\)$"
)
_WORD = re.compile(r"[^\w\s]+", flags=re.UNICODE)


@dataclass(frozen=True)
class Measure:
    """One unit expressed as ``size`` of a base unit within a dimension."""

    dimension: Dimension
    base: str
    size: Decimal


def inventory_amount(
    amount: Decimal, recipe_unit: str, item_unit: str, food: str
) -> Decimal | None:
    """Return ``amount`` of ``recipe_unit`` in ``item_unit``, or None if unrelated."""
    recipe = _measure(recipe_unit, food)
    item = _measure(item_unit, food)
    if (recipe.dimension, recipe.base) != (item.dimension, item.base):
        return None
    return amount * recipe.size / item.size


def unmeasured_package_amount(
    amount: Decimal, recipe_unit: str, item_unit: str, food: str
) -> Decimal | None:
    """Return grams or millilitres drawn from a package the kitchen didn't weigh.

    Households record salt, spices and spreads as "1 container" or "1 jar",
    which no recipe amount converts into. The caller lets such a package cover
    a seasoning-sized amount. This returns ``None`` when the item has a real
    measure or the recipe amount isn't a weight or volume.
    """
    recipe = _measure(recipe_unit, food)
    item = _measure(item_unit, food)
    if item.dimension != "count" or recipe.dimension == "count":
        return None
    return amount * recipe.size


def same_food(a: str, b: str) -> bool:
    """Return whether two food names match, ignoring case, punctuation and plurals."""
    return _food_key(a) == _food_key(b)


def _measure(unit: str, food: str) -> Measure:
    text = " ".join(unit.casefold().replace(".", "").split())
    package = _PACKAGE_SIZE.match(text)
    if package is not None:
        inner = _measure(package["inner"], food)
        return Measure(
            inner.dimension, inner.base, inner.size * Decimal(package["size"])
        )
    word = _singular_phrase(text)
    if word in _MASS:
        return Measure("mass", "g", _MASS[word])
    if word in _VOLUME:
        return Measure("volume", "ml", _VOLUME[word])
    if word in {"lbs", "ozs"}:
        return Measure("mass", "g", _MASS[word[:-1]])
    count = _COUNT_ALIASES.get(word, word)
    food_count = _FOOD_COUNTS.get((_food_key(food), count))
    if food_count is not None:
        return Measure("count", food_count[0], food_count[1])
    return Measure("count", count, Decimal("1"))


def _food_key(name: str) -> str:
    return _singular_phrase(" ".join(_WORD.sub(" ", name.casefold()).split()))


def _singular_phrase(text: str) -> str:
    return " ".join(_singular(word) for word in text.split())


def _singular(word: str) -> str:
    if len(word) <= 3 or word.endswith(("ss", "us", "is")):
        return word
    if word.endswith("ies"):
        return word[:-3] + "y"
    if word.endswith(("oes", "ches", "shes", "xes", "sses")):
        return word[:-2]
    if word.endswith("s"):
        return word[:-1]
    return word
