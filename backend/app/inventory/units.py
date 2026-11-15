"""Convert one recipe amount into a food's stock unit.

Every food is stocked in grams, millilitres, or a count of its own unit (a head
of garlic, a can of cola). Recipes use cooking units instead (cloves,
tablespoons, cups). ``to_stock`` turns one recipe amount into the food's stock
base using, in order, the household's own facts for that food, the generic
food profile's estimates, and the fixed mass and volume tables.

The result says how much to trust the number: ``Exact`` used only fixed tables
and household facts, ``Approximate`` used at least one profile estimate (the
app shows "about"), ``Small`` is an amount that may need no number at all, and
``AskAtCook`` means the cook flow asks the user. Whether a ``Small`` amount is
small enough depends on the food's total across the whole recipe, so the cook
planner decides that, not this module. A recipe amount never raises. Callers
pass amounts and facts as ``Decimal``, converting floats with
``Decimal(str(x))`` at their own boundary. Nothing is rounded here. The cook
planner rounds once per food per cook.

``measure`` and ``in_stock`` compare a recipe amount with a stock amount
without a food's facts, for the recipe judge and the eval scorer.
"""

from __future__ import annotations

import re
from collections.abc import Mapping
from dataclasses import dataclass, field
from decimal import Decimal
from typing import Literal, NamedTuple

StockBase = Literal["g", "ml", "each"]
MeasuredUnit = Literal["g", "ml"]
AskReason = Literal[
    "invalid_amount",
    "unknown_unit",
    "needs_package_size",
    "needs_density",
    "needs_each_size",
]

PACKAGE_WORDS = frozenset(
    (
        "bag", "bottle", "box", "can", "canister", "carton", "case", "container",
        "jar", "jug", "pack", "package", "packet", "pitcher", "pouch", "serving",
        "tin", "tray", "tub", "tube",
    )
)  # fmt: skip
"""Counted units that hold an unknown amount of a food, such as a carton.

A profile's ``"each"`` weight is one whole item, such as one egg. It never
sizes a package, such as a carton of eggs, so ``to_stock`` asks for the
package's size instead. Every word is in ``normalize_unit`` form.
"""

_MASS = {
    "g": Decimal("1"),
    "kg": Decimal("1000"),
    "mg": Decimal("0.001"),
    "oz": Decimal("28.349523125"),
    "lb": Decimal("453.59237"),
}
_VOLUME = {
    "ml": Decimal("1"),
    "l": Decimal("1000"),
    "tsp": Decimal("4.92892159375"),
    "tbsp": Decimal("14.78676478125"),
    "fl oz": Decimal("29.5735295625"),
    "cup": Decimal("236.5882365"),
    "pt": Decimal("473.176473"),
    "qt": Decimal("946.352946"),
    "gal": Decimal("3785.411784"),
}
_SEASONING_ML = {
    "pinch": _VOLUME["tsp"] / 16,
    "dash": _VOLUME["tsp"] / 8,
}
_OFFERED_TABLE_UNITS = (
    "g", "kg", "oz", "lb", "ml", "l", "tsp", "tbsp", "cup", "fl oz",
)  # fmt: skip
_SEASONING_SPOONS = frozenset(("tsp", "tbsp", "pinch", "dash"))
_SIZE_ONLY_WORDS = frozenset(
    ("extra small", "small", "medium", "large", "extra large", "jumbo", "big")
)
_SYNONYMS = {
    "g": ("gram",),
    "kg": ("kilogram",),
    "mg": ("milligram",),
    "oz": ("ounce",),
    "lb": ("pound",),
    "ml": ("milliliter", "millilitre"),
    "l": ("liter", "litre"),
    "tsp": ("teaspoon",),
    "tbsp": ("tablespoon", "tbs", "tbl"),
    "cup": ("c",),
    "fl oz": ("fluid ounce",),
    "pt": ("pint",),
    "qt": ("quart",),
    "gal": ("gallon",),
    "head": ("bulb",),
    "each": ("", "item", "piece", "pc", "whole", "ea", "ct", "count"),
}
_ALIASES = {word: key for key, words in _SYNONYMS.items() for word in words}
# Abbreviation periods ("tbsp.", "fl. oz.") are dropped; decimal points are not.
_ABBREVIATION_PERIOD = re.compile(r"\.(?!\d)")
# Plurals the suffix rules in _singular get wrong, including abbreviations too
# short for them.
_IRREGULAR_PLURALS = {
    **{f"{key}s": key for key in ("g", "kg", "lb", "ml", "oz", "pt", "qt", "pc")},
    "leaves": "leaf",
    "loaves": "loaf",
    "halves": "half",
    "cookies": "cookie",
    "pies": "pie",
}
_SIZE_WORDS = re.compile(
    r"\b(extra[ -]large|small|medium|large|jumbo|big|heaping|heaped|level|scant"
    r"|rounded|generous)\b"
)
_IRREGULAR_PLURAL_OF = {
    singular: plural for plural, singular in _IRREGULAR_PLURALS.items()
}


@dataclass(frozen=True)
class ProfileFacts:
    """Estimates from a generic food profile (garlic, rice), shared by households.

    ``unit_grams`` maps a unit word to its weight, e.g. ``{"clove": 3,
    "head": 40, "medium": 110}``; the key ``"each"`` is one whole item, never
    a package (see ``PACKAGE_WORDS``). Keys are normalized with
    ``normalize_unit`` when the facts are built.
    """

    g_per_ml: Decimal | None = None
    unit_grams: Mapping[str, Decimal] = field(default_factory=dict)

    def __post_init__(self) -> None:
        _require_positive(self.g_per_ml, *self.unit_grams.values())
        object.__setattr__(self, "unit_grams", _normalize_keys(self.unit_grams))


@dataclass(frozen=True)
class FoodFacts:
    """One household food: its stock base, its own unit facts and its profile.

    ``each_label`` names the counted unit and is set exactly when
    ``stock_base`` is ``"each"``. ``whole_units_only`` marks counted foods that
    cannot be split (eggs, cans), so a cook draws a whole number of them.
    ``household_units`` maps a unit word to its amount in the stock base, for
    example ``{"clove": 0.1}`` for garlic stocked in heads. Household facts are
    exact, and profile facts are estimates. The label and unit words are normalized with
    ``normalize_unit`` when the facts are built.
    """

    stock_base: StockBase
    each_label: str | None = None
    whole_units_only: bool = False
    grams_per_each: Decimal | None = None
    ml_per_each: Decimal | None = None
    g_per_ml: Decimal | None = None
    household_units: Mapping[str, Decimal] = field(default_factory=dict)
    profile: ProfileFacts | None = None

    def __post_init__(self) -> None:
        if (self.stock_base == "each") != (self.each_label is not None):
            raise ValueError("each_label is required exactly when stock_base is each")
        if self.whole_units_only and self.stock_base != "each":
            raise ValueError("whole_units_only requires stock_base each")
        _require_positive(
            self.grams_per_each,
            self.ml_per_each,
            self.g_per_ml,
            *self.household_units.values(),
        )
        if self.each_label is not None:
            object.__setattr__(self, "each_label", normalize_unit(self.each_label))
        object.__setattr__(
            self, "household_units", _normalize_keys(self.household_units)
        )


@dataclass(frozen=True)
class Exact:
    """An amount in the food's stock base from fixed tables and household facts."""

    amount: Decimal


@dataclass(frozen=True)
class Approximate:
    """An amount in the food's stock base that used a profile estimate."""

    amount: Decimal


@dataclass(frozen=True)
class AskAtCook:
    """No conversion path exists, so the cook flow asks how much was used."""

    reason: AskReason


@dataclass(frozen=True)
class Small:
    """An amount in grams or millilitres that needs no number if small enough.

    Returned for pinch, dash and to taste (always in ml), and for any grams or
    millilitres from a counted package whose size is unknown in that dimension
    (a container of salt). ``otherwise`` is what the line converts to when the
    food's total across the recipe is too large to skip. For a seasoning word
    it is the normal conversion. For a package it is the ``AskAtCook`` with its
    real reason. The cook planner applies the limit.
    """

    amount: Decimal
    unit: MeasuredUnit
    otherwise: Exact | Approximate | AskAtCook


Conversion = Exact | Approximate | Small | AskAtCook


class Measure(NamedTuple):
    """An amount in grams, millilitres, or a counted unit.

    ``dimension`` is ``"g"`` for mass, ``"ml"`` for volume, or the
    ``normalize_unit`` key of any other unit word (``"each"``, ``"clove"``,
    ``"large"``). ``amount`` is in that base. ``in_stock`` is the only
    comparison between measures.
    """

    amount: Decimal
    dimension: str


class _Value(NamedTuple):
    amount: Decimal
    estimated: bool


class _Quantity(NamedTuple):
    amount: Decimal
    dimension: StockBase
    estimated: bool


class _NoPath(Exception):
    def __init__(self, reason: AskReason) -> None:
        self.reason = reason


def normalize_unit(text: str) -> str:
    """Return the lookup key for a unit word ("Tablespoons" -> "tbsp").

    Casefolds, drops abbreviation periods and a leading "a"/"an", singularizes
    each word and maps abbreviations, synonyms and count words onto one key.
    Size words are kept; ``to_stock`` strips them only as a fallback.
    """
    text = _ABBREVIATION_PERIOD.sub("", text.casefold())
    words = [_singular(word) for word in text.split()]
    if words[:1] in (["a"], ["an"]):
        words = words[1:]
    key = " ".join(words)
    return _ALIASES.get(key, key)


def table_unit(text: str) -> tuple[MeasuredUnit, Decimal] | None:
    """Look up a unit in the fixed mass and volume tables.

    The text is normalized with ``normalize_unit`` first, so "Cups" and "kgs"
    are found. A bare "oz" is weight, because ounces are in the mass table and
    fluid ounces are spelled "fl oz". Size words are not stripped, so "large
    cup" is not a table unit.

    Args:
        text: A unit as written, in any case, singular or plural.

    Returns:
        The unit's dimension (``"g"`` or ``"ml"``) and how many grams or
        millilitres one of it is, or ``None`` when neither table has it.
    """
    key = normalize_unit(text)
    if key in _MASS:
        return "g", _MASS[key]
    if key in _VOLUME:
        return "ml", _VOLUME[key]
    return None


def measure(amount: Decimal, unit: str) -> Measure:
    """Express an amount in grams, millilitres, or its own unit word.

    Mass and volume units convert through the fixed tables, so 2 kg and 300 g
    both measure in grams. Any other unit word is its own dimension after
    ``normalize_unit``, so "pieces" and "item" both measure as ``"each"``
    while "large" stays ``"large"``. Comparing a mass with a count needs the
    food's facts, which only ``to_stock`` reads.

    Args:
        amount: The amount as written, not validated, so it may be zero or
            negative.
        unit: The unit as written, in any case, singular or plural.

    Returns:
        The amount in its dimension's base.
    """
    table = table_unit(unit)
    if table is None:
        return Measure(amount, normalize_unit(unit))
    dimension, factor = table
    return Measure(amount * factor, dimension)


def in_stock(amount: Decimal, unit: str, stock: Measure) -> Decimal | None:
    """Return ``amount`` of ``unit`` in ``stock``'s dimension, or ``None``.

    Follows ``to_stock`` where the unit word alone is ambiguous: a bare "oz"
    is fluid ounces when the stock is a volume, and a size word such as
    "large" counts as one whole item. ``None`` means the two dimensions differ,
    so the amounts cannot be compared without the food's facts.

    Args:
        amount: The recipe's amount as written.
        unit: The recipe's unit as written, in any case, singular or plural.
        stock: The stocked amount, from ``measure``.
    """
    key = normalize_unit(unit)
    if key == "oz" and stock.dimension == "ml":
        key = "fl oz"
    for candidate in dict.fromkeys([key, normalize_unit(_SIZE_WORDS.sub("", key))]):
        used = measure(amount, candidate)
        if used.dimension == stock.dimension:
            return used.amount
    return None


def convertible_units(food: FoodFacts) -> tuple[str, ...]:
    """Return the recipe units that ``to_stock`` converts to a number for ``food``.

    Recipe generation offers only these units, so every amount it writes
    converts at cook time instead of being asked about. A unit is offered when
    one of it converts exactly or approximately. A seasoning spoon (tsp, tbsp,
    pinch, dash) is also offered when it is only ``Small``, as for salt in a
    container of unknown size, because a seasoning-sized amount needs no
    number.

    Returns:
        Unit words in ``normalize_unit`` form: the food's stock unit first,
        then its household words, its profile words (size words such as
        "large" left out), "each" for a food not counted in items, and the
        common mass and volume units. No word appears twice.
    """
    stock_unit = food.each_label or food.stock_base
    profile_words = () if food.profile is None else food.profile.unit_grams
    candidates = dict.fromkeys(
        (
            stock_unit,
            *food.household_units,
            *(word for word in profile_words if word not in _SIZE_ONLY_WORDS),
            *(() if food.stock_base == "each" else ("each",)),
            *_OFFERED_TABLE_UNITS,
            *_SEASONING_ML,
        )
    )
    return tuple(unit for unit in candidates if _offers(unit, food))


def _offers(unit: str, food: FoodFacts) -> bool:
    conversion = to_stock(Decimal(1), unit, food)
    if isinstance(conversion, Small):
        return unit in _SEASONING_SPOONS or not isinstance(
            conversion.otherwise, AskAtCook
        )
    return not isinstance(conversion, AskAtCook)


def to_stock(amount: Decimal, unit: str, food: FoodFacts) -> Conversion:
    """Convert ``amount`` of recipe ``unit`` into ``food``'s stock base.

    A bare count ("2 whole", "2 large") means whole items. For a food counted
    in one of ``PACKAGE_WORDS``, one whole item is not one package. Whole items
    convert through the item's weight, which gives a ``Small`` amount that
    asks for the package's size unless the household knows it. With no item
    weight, the result asks for the item's size.

    Args:
        amount: The recipe's amount. A zero, negative or non-finite amount
            returns ``AskAtCook("invalid_amount")``, except for "to taste".
        unit: The recipe's unit as written, in any case, singular or plural.
        food: The food the line draws from.

    Returns:
        The amount in ``food.stock_base`` with how much to trust it, a
        ``Small`` amount for the cook planner to judge, or the reason the cook
        flow must ask.
    """
    key = normalize_unit(unit)
    # "to taste" carries no real amount, and recipes often send 0 for it.
    if key == "to taste":
        return Small(Decimal("0"), "ml", Exact(Decimal("0")))
    if not amount.is_finite() or amount <= 0:
        return AskAtCook("invalid_amount")
    for candidate in dict.fromkeys([key, normalize_unit(_SIZE_WORDS.sub("", key))]):
        if candidate in _SEASONING_ML:
            ml = amount * _SEASONING_ML[candidate]
            return Small(ml, "ml", _into_stock(_Quantity(ml, "ml", False), food))
        measured = _measure(amount, candidate, food)
        if isinstance(measured, AskAtCook):
            return measured
        if measured is not None:
            conversion = _into_stock(measured, food)
            dimension = measured.dimension
            # A counted package with no size in the recipe's dimension still
            # needs no number for a seasoning-sized amount.
            if (
                isinstance(conversion, AskAtCook)
                and food.stock_base == "each"
                and dimension != "each"
            ):
                return Small(measured.amount, dimension, conversion)
            return conversion
    return AskAtCook("unknown_unit")


def _measure(
    amount: Decimal, key: str, food: FoodFacts
) -> _Quantity | AskAtCook | None:
    base = food.stock_base
    packaged_item = key == "each" and _counts_packages(food)
    whole_item = key == "each" and not packaged_item
    if base == "each" and (whole_item or key == food.each_label):
        return _Quantity(amount, "each", False)
    if key in food.household_units:
        return _Quantity(amount * food.household_units[key], base, False)
    if whole_item:
        return _Quantity(amount, "each", False)
    if key == "oz" and base == "ml":
        key = "fl oz"
    table = _table_quantity(amount, key)
    # A standard unit already in the stock base converts exactly; a profile
    # weight for it (USDA lists "1 tbsp") would only add a density estimate.
    if table is not None and table.dimension == base:
        return table
    if food.profile is not None and key in food.profile.unit_grams:
        return _Quantity(amount * food.profile.unit_grams[key], "g", True)
    if packaged_item:
        return AskAtCook("needs_each_size")
    return table


def _table_quantity(amount: Decimal, key: str) -> _Quantity | None:
    table = table_unit(key)
    if table is None:
        return None
    dimension, factor = table
    return _Quantity(amount * factor, dimension, False)


def _into_stock(
    measured: _Quantity, food: FoodFacts
) -> Exact | Approximate | AskAtCook:
    amount, dimension, estimated = measured
    base = food.stock_base
    try:
        if dimension == base:
            value, used_profile = amount, False
        elif base != "each" and dimension == "each":
            size, used_profile = _each_size(food, base)
            value = amount * size
        elif base == "each" and dimension != "each":
            try:
                size, used_profile = _each_size(food, dimension)
            except _NoPath as missing:
                if missing.reason == "needs_each_size":
                    return AskAtCook("needs_package_size")
                raise
            value = amount / size
        elif base != "each" and dimension != "each":
            value, used_profile = _between(amount, dimension, food)
    except _NoPath as missing:
        return AskAtCook(missing.reason)
    return Approximate(value) if estimated or used_profile else Exact(value)


def _each_size(food: FoodFacts, dimension: MeasuredUnit) -> _Value:
    direct = _per_each(food, dimension)
    if direct is not None:
        return direct
    other: MeasuredUnit = "ml" if dimension == "g" else "g"
    indirect = _per_each(food, other)
    if indirect is None:
        raise _NoPath("needs_each_size")
    size = _between(indirect.amount, other, food)
    return _Value(size.amount, size.estimated or indirect.estimated)


def _per_each(food: FoodFacts, dimension: MeasuredUnit) -> _Value | None:
    if dimension == "ml":
        return None if food.ml_per_each is None else _Value(food.ml_per_each, False)
    if food.grams_per_each is not None:
        return _Value(food.grams_per_each, False)
    if food.profile is None:
        return None
    sizes = food.profile.unit_grams
    if food.each_label in sizes:
        return _Value(sizes[food.each_label], True)
    if "each" in sizes and not _counts_packages(food):
        return _Value(sizes["each"], True)
    return None


def _counts_packages(food: FoodFacts) -> bool:
    """Return whether one counted unit of ``food`` holds many whole items."""
    return food.each_label in PACKAGE_WORDS


def _between(amount: Decimal, source: MeasuredUnit, food: FoodFacts) -> _Value:
    if food.g_per_ml is not None:
        density, used_profile = food.g_per_ml, False
    elif food.profile is not None and food.profile.g_per_ml is not None:
        density, used_profile = food.profile.g_per_ml, True
    else:
        raise _NoPath("needs_density")
    return _Value(
        amount * density if source == "ml" else amount / density, used_profile
    )


def _normalize_keys(units: Mapping[str, Decimal]) -> dict[str, Decimal]:
    normalized: dict[str, Decimal] = {}
    for word, size in units.items():
        key = normalize_unit(word)
        if normalized.get(key, size) != size:
            raise ValueError(f"unit words collide as {key!r} with different sizes")
        normalized[key] = size
    return normalized


def _require_positive(*facts: Decimal | None) -> None:
    for fact in facts:
        if fact is not None and not (fact.is_finite() and fact > 0):
            raise ValueError(f"unit facts must be positive and finite, got {fact}")


def pluralize(word: str) -> str:
    """Return the plural of a singular unit word ("loaf" -> "loaves")."""
    if word in _IRREGULAR_PLURAL_OF:
        return _IRREGULAR_PLURAL_OF[word]
    if word.endswith(("s", "x", "z", "ch", "sh")):
        return word + "es"
    if word.endswith("y") and word[-2:-1] not in ("", *"aeiou"):
        return word[:-1] + "ies"
    return word + "s"


def _singular(word: str) -> str:
    if word in _IRREGULAR_PLURALS:
        return _IRREGULAR_PLURALS[word]
    if len(word) <= 3 or word.endswith(("ss", "us", "is")):
        return word
    if word.endswith("ies"):
        return word[:-3] + "y"
    if word.endswith(("oes", "ches", "shes", "xes", "sses")):
        return word[:-2]
    if word.endswith("s"):
        return word[:-1]
    return word
