"""Plan how much one cook takes from each food in stock.

A recipe lists ingredient lines in cooking units, and several lines can use the
same food (salt in the rub and again in the sauce). ``plan_cook`` groups the
lines by food, converts each with ``to_stock``, and folds them into one
``FoodPlan`` per food: the summed draw in the food's stock base, rounded once,
plus what the cook flow must show or ask about. Summing before rounding keeps
small per-line errors from adding up. The Small limit is checked against the
per-food total too, so three "1 tbsp salt" lines do not each pass as a pinch:
once a food's ``Small`` lines pass the limit together, each converts to its
``otherwise``.

The planner is pure: the caller supplies each food's facts and available stock,
and the plan reports shortfalls rather than refusing to cook.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from decimal import ROUND_CEILING, ROUND_HALF_UP, Decimal
from uuid import UUID

from app.inventory.units import (
    Approximate,
    AskAtCook,
    AskReason,
    Exact,
    FoodFacts,
    MeasuredUnit,
    Small,
    StockBase,
    pluralize,
    to_stock,
)

# Seasoning-sized totals at or under this many grams or millilitres per food
# are not drawn from stock or asked about.
_SMALL_LIMIT = Decimal(15)
_PRECISION: dict[StockBase, Decimal] = {
    "g": Decimal("0.1"),
    "ml": Decimal("0.1"),
    "each": Decimal("0.001"),
}
_NOTE_PLACES = (Decimal("0.1"), Decimal("0.01"), Decimal("0.001"))


@dataclass(frozen=True)
class CookLine:
    """One recipe ingredient line, as recipe generation names it."""

    food_id: UUID
    amount: Decimal
    unit: str


@dataclass(frozen=True)
class FoodStock:
    """One food's facts and how much of it is available, in its stock base.

    ``available`` counts unexpired, not depleted stock.
    """

    facts: FoodFacts
    available: Decimal

    def __post_init__(self) -> None:
        if not (self.available.is_finite() and self.available >= 0):
            raise ValueError(f"available must be finite and >= 0, got {self.available}")


@dataclass(frozen=True)
class LineAsk:
    """A line the cook flow asks about, with the recipe's own amount and unit.

    ``line`` indexes the lines passed to ``plan_cook``.
    """

    line: int
    amount: Decimal
    unit: str
    reason: AskReason


@dataclass(frozen=True)
class SmallTotal:
    """A food's seasoning-sized lines summed; never drawn from stock.

    Grams and millilitres count alike, so a mixed total is reported in ml.
    """

    amount: Decimal
    unit: MeasuredUnit


@dataclass(frozen=True)
class WholeUnitRounding:
    """A whole-unit food whose draw was rounded up from what the recipe needs."""

    needs: Decimal
    note: str


@dataclass(frozen=True)
class FoodPlan:
    """What one cook takes from one food, summed over the lines that use it.

    ``draw`` is in ``stock_base`` and rounded once; it is 0 when nothing is
    drawn. ``estimated`` means a profile estimate went into it (shown "about").
    ``small`` is set when the food's seasoning-sized lines stay under the
    Small limit together. ``shortfall`` is how much of the draw the available
    stock does not cover.
    """

    food_id: UUID
    stock_base: StockBase
    lines: tuple[int, ...]
    draw: Decimal
    estimated: bool
    small: SmallTotal | None
    asks: tuple[LineAsk, ...]
    rounding: WholeUnitRounding | None
    shortfall: Decimal


@dataclass(frozen=True)
class CookPlan:
    """One ``FoodPlan`` per food, ordered by the food's first line."""

    foods: tuple[FoodPlan, ...]


def plan_cook(lines: Sequence[CookLine], stock: Mapping[UUID, FoodStock]) -> CookPlan:
    """Plan the draw on each food for cooking ``lines`` against ``stock``.

    Raises ``ValueError`` when a line names a food missing from ``stock``.
    """
    by_food: dict[UUID, list[int]] = {}
    for index, line in enumerate(lines):
        if line.food_id not in stock:
            raise ValueError(f"no stock given for food {line.food_id}")
        by_food.setdefault(line.food_id, []).append(index)
    return CookPlan(
        tuple(
            _plan_food(food_id, indices, lines, stock[food_id])
            for food_id, indices in by_food.items()
        )
    )


def _plan_food(
    food_id: UUID, indices: list[int], lines: Sequence[CookLine], stock: FoodStock
) -> FoodPlan:
    facts = stock.facts
    converted = [
        (index, to_stock(lines[index].amount, lines[index].unit, facts))
        for index in indices
    ]
    smalls = [
        conversion for _, conversion in converted if isinstance(conversion, Small)
    ]
    small_amount = sum((small.amount for small in smalls), Decimal(0))
    small = (
        SmallTotal(small_amount, _small_unit(smalls))
        if smalls and small_amount <= _SMALL_LIMIT
        else None
    )
    settled = [
        (index, conversion.otherwise if isinstance(conversion, Small) else conversion)
        for index, conversion in converted
        if small is None or not isinstance(conversion, Small)
    ]
    measured = [c for _, c in settled if isinstance(c, (Exact, Approximate))]
    need = sum((conversion.amount for conversion in measured), Decimal(0))
    draw, rounding = _round(need, facts)
    return FoodPlan(
        food_id=food_id,
        stock_base=facts.stock_base,
        lines=tuple(indices),
        draw=draw,
        estimated=any(isinstance(c, Approximate) for c in measured),
        small=small,
        asks=tuple(
            LineAsk(index, lines[index].amount, lines[index].unit, conversion.reason)
            for index, conversion in settled
            if isinstance(conversion, AskAtCook)
        ),
        rounding=rounding,
        shortfall=max(Decimal(0), draw - stock.available),
    )


def _small_unit(smalls: Sequence[Small]) -> MeasuredUnit:
    """The unit the Small lines agree on, ignoring "to taste"; else ml."""
    units = {small.unit for small in smalls if small.amount}
    return units.pop() if len(units) == 1 else "ml"


def _round(need: Decimal, facts: FoodFacts) -> tuple[Decimal, WholeUnitRounding | None]:
    # Settling at the stock base's precision first absorbs Decimal division
    # noise, so an exact 6 that computes as 6.000...001 does not round up to 7.
    settled = need.quantize(_PRECISION[facts.stock_base], ROUND_HALF_UP)
    if not facts.whole_units_only:
        return settled, None
    uses = settled.to_integral_value(ROUND_CEILING)
    if uses == settled:
        return uses, None
    note = f"Uses {_count(uses, facts)}, recipe needs about {_format_need(need)}"
    return uses, WholeUnitRounding(needs=need, note=note)


def _count(uses: Decimal, facts: FoodFacts) -> str:
    label = facts.each_label
    # The generic "each" label ("piece", "item") reads best as a bare number.
    if label is None or label == "each":
        return f"{uses}"
    return f"{uses} {label if uses == 1 else pluralize(label)}"


def _format_need(need: Decimal) -> str:
    # One decimal reads best ("about 1.4"), but a need that one decimal shows
    # as a whole number ("needs about 1" next to "Uses 2") gets more places.
    for places in _NOTE_PLACES:
        shown = need.quantize(places, ROUND_HALF_UP)
        if shown != shown.to_integral_value():
            break
    return f"{shown:f}"
