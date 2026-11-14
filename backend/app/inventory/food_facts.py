"""Turn ``public.food_facts`` rows into converter input.

``food_facts`` has one row per household food with the food's own unit facts,
its household unit words, and the facts of its resolved food profile (a pinned
``foods.profile_key``, else the alias match on the food's name). This module is
the boundary where the row's numbers, which arrive as JSON floats, ints or
strings, become ``Decimal``. ``FoodLine`` merges that row with the food's
``public.food_stock`` row for recipe generation.
"""

from __future__ import annotations

from collections.abc import Mapping
from datetime import date
from decimal import Decimal, InvalidOperation
from typing import Any

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    FiniteFloat,
    NonNegativeInt,
    PositiveFloat,
    PrivateAttr,
    model_validator,
)

from app.inventory.units import FoodFacts, ProfileFacts, StockBase


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


class FoodLine(BaseModel):
    """One household food as recipe generation sees it, summed over its batches.

    The fields are a ``public.food_stock`` row merged with the food's
    ``public.food_facts`` row. Other columns are ignored.

    Attributes:
        id: The food's id. Generated ingredients name it as
            ``inventory_item_id``.
        name: The food's name.
        category: The food's category name, or ``None`` when it has none.
        available: The unexpired stock, in ``stock_unit``.
        next_expiry: The soonest unexpired batch's date, or ``None`` when no
            batch has one.
        lot_count: How many batches the food has, expired ones included.
        stock_base: ``"g"``, ``"ml"`` or ``"each"``.
        each_label: The counted unit, such as "head". Set exactly when
            ``stock_base`` is ``"each"``.
        grams_per_each, ml_per_each, g_per_ml: The household's own size and
            density facts, or ``None`` when unknown.
        household_units: Unit word to its amount in the stock base.
        profile_key: The linked food profile, or ``None`` when unmatched.
        profile_g_per_ml: The profile's density, or ``None``.
        profile_unit_grams: Unit word to grams from the profile, or ``None``
            when ``profile_key`` is ``None``.

    Raises:
        ValidationError: On validation, when a fact is not positive or the
            stock base and each label disagree.
    """

    model_config = ConfigDict(extra="ignore")

    id: str = Field(min_length=1)
    name: str = Field(min_length=1)
    category: str | None = None
    available: FiniteFloat = Field(ge=0)
    next_expiry: date | None = None
    lot_count: NonNegativeInt = 1
    stock_base: StockBase
    each_label: str | None = None
    grams_per_each: PositiveFloat | None = None
    ml_per_each: PositiveFloat | None = None
    g_per_ml: PositiveFloat | None = None
    household_units: dict[str, PositiveFloat] = Field(default_factory=dict)
    profile_key: str | None = None
    profile_g_per_ml: PositiveFloat | None = None
    profile_unit_grams: dict[str, PositiveFloat] | None = None

    _facts: FoodFacts = PrivateAttr()

    @model_validator(mode="after")
    def _build_facts(self) -> FoodLine:
        row = self.model_dump()
        row["profile_unit_grams"] = row["profile_unit_grams"] or {}
        self._facts = food_facts_from_row(row)
        return self

    @property
    def facts(self) -> FoodFacts:
        """The food's unit facts for the converter."""
        return self._facts

    @property
    def stock_unit(self) -> str:
        """The word ``available`` is counted in, such as "g", "ml" or "head"."""
        return self._facts.each_label or self.stock_base


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
