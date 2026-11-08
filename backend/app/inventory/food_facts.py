"""Turn a ``public.food_facts`` row into converter input.

``food_facts`` has one row per household food with the food's own unit facts,
its household unit words, and the facts of its resolved food profile (a pinned
``foods.profile_key``, else the alias match on the food's name). This module is
the boundary where the row's numbers, which arrive as JSON floats, ints or
strings, become ``Decimal``.
"""

from __future__ import annotations

from collections.abc import Mapping
from decimal import Decimal, InvalidOperation
from typing import Any

from app.inventory.units import FoodFacts, ProfileFacts


def food_facts_from_row(row: Mapping[str, Any]) -> FoodFacts:
    """Build ``FoodFacts`` from one ``public.food_facts`` row.

    Args:
        row: A ``food_facts`` row as a mapping. It needs ``stock_base``,
            ``each_label``, ``grams_per_each``, ``ml_per_each``, ``g_per_ml``,
            ``household_units`` (unit word to amount in the stock base),
            ``profile_key``, ``profile_g_per_ml`` and ``profile_unit_grams``
            (unit word to grams). Numbers may be ints, floats, strings or
            ``Decimal``. ``household_units`` is never null, and
            ``profile_unit_grams`` is null only when ``profile_key`` is.

    Returns:
        The food's facts, with ``profile`` set exactly when ``profile_key`` is
        not null.

    Raises:
        KeyError: When a needed column is missing.
        ValueError: When a fact is not a number, is not finite or is not
            positive, or when the stock base and each label disagree.
    """
    profile = None
    if row["profile_key"] is not None:
        profile = ProfileFacts(
            g_per_ml=_decimal(row["profile_g_per_ml"]),
            unit_grams=_decimals(row["profile_unit_grams"]),
        )
    return FoodFacts(
        stock_base=row["stock_base"],
        each_label=row["each_label"],
        grams_per_each=_decimal(row["grams_per_each"]),
        ml_per_each=_decimal(row["ml_per_each"]),
        g_per_ml=_decimal(row["g_per_ml"]),
        household_units=_decimals(row["household_units"]),
        profile=profile,
    )


def _decimal(value: Any) -> Decimal | None:
    return None if value is None else _number(value)


def _decimals(values: Mapping[str, Any]) -> dict[str, Decimal]:
    return {key: _number(value) for key, value in values.items()}


def _number(value: Any) -> Decimal:
    # str() first so a float such as 0.1 keeps its short form, not its binary
    # expansion. Finiteness and sign are checked by FoodFacts and ProfileFacts.
    try:
        return Decimal(str(value))
    except InvalidOperation:
        raise ValueError(f"unit fact is not a number: {value!r}") from None
