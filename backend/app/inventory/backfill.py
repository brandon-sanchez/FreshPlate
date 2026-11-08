"""Plan the move of ``inventory_items`` rows into foods and lots.

The foods-and-lots model (spec #104) keeps one food per thing a household
stocks, with one stock base (grams, millilitres or a count of ``each_label``),
and one lot per batch. This module turns today's free-text inventory rows into
that shape without touching a database: ``plan_backfill`` returns a typed
``BackfillPlan`` with one ``HouseholdPlan`` per household, which the dry-run
CLI prints and the real backfill inserts. Every judgment call becomes a
``Guess`` and every row that cannot move becomes a ``SkippedRow``, so a human
can review the plan before anything is written.

Each lot keeps its ``inventory_items`` id, so ``cook_events`` deductions that
name an item id keep resolving to the same batch after the move.
"""

from __future__ import annotations

import re
from collections import Counter, defaultdict
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import date, datetime
from decimal import Decimal
from typing import Literal
from uuid import UUID

from app.inventory.units import FoodFacts, StockBase, normalize_unit, table_unit

# Mirrors the foods.name CHECK in
# supabase/migrations/20261107120000_add_foods_and_lots.sql.
_MAX_FOOD_NAME_LENGTH = 80

# Table units whose reading is a judgment call; ``{size}`` becomes the table's
# amount. Every other unit the tables know has one meaning.
_MEASURED_GUESSES = {
    "oz": "read as weight ounces ({size}), not fluid ounces",
    "cup": "read as US cups ({size})",
    "pt": "read as US pints ({size})",
    "qt": "read as US quarts ({size})",
    "gal": "read as US gallons ({size})",
}
_WHITESPACE = re.compile(r"\s+")
_WORDS = r"[A-Za-z]+(?: [A-Za-z]+)*"
# "<label> (<count> <inner unit>[ each])". The inner words match lazily so a
# trailing "each" is read as the marker, not as part of the inner unit.
_PACKAGE = re.compile(
    rf"^({_WORDS})\s*\(\s*(\d+(?:\.\d+)?)\s*([A-Za-z]+(?: [A-Za-z]+)*?)"
    r"(\s+each)?\s*\)$",
    re.IGNORECASE,
)
_BARE_WORDS = re.compile(rf"^{_WORDS}$")


@dataclass(frozen=True)
class _UnitSize:
    word: str


_Fact = Literal["grams", "millilitres"] | _UnitSize


@dataclass(frozen=True)
class InventoryRow:
    """One ``inventory_items`` row, as read from the database.

    ``quantity`` is in ``unit``, a free-text unit the user typed. ``depleted_at``
    is set once a cook used the row up. ``clean_name`` is the name with
    whitespace runs collapsed and trimmed, and ``name_key`` is
    ``public.food_name_key(name)``. Both come from SQL because Postgres
    whitespace and case rules depend on the database locale, and they must
    match what ``add_lot`` stores and the unique ``(household_id, name_key)``
    key on foods.
    """

    id: UUID
    household_id: UUID
    name: str
    clean_name: str
    name_key: str
    quantity: Decimal
    unit: str
    expiration_date: date | None
    storage_location: str
    category_id: UUID | None
    notes: str | None
    added_by: UUID | None
    created_at: datetime
    updated_at: datetime
    depleted_at: datetime | None


@dataclass(frozen=True)
class CookRef:
    """One inventory item id that a household's ``cook_events`` deducted from."""

    household_id: UUID
    item_id: UUID


@dataclass(frozen=True)
class StockShape:
    """How a food's stock is counted; every lot of one food shares it.

    ``each_label`` is set exactly when ``stock_base`` is ``"each"``.
    ``grams_per_each`` and ``ml_per_each`` give the size of one counted item
    when a unit stated it. ``household_units`` maps a unit word to its amount
    in the stock base, e.g. ``(("serving", Decimal(1) / 14),)`` for a container
    of 14 servings; these become ``food_units`` rows.

    Raises:
        ValueError: On construction, when the shape breaks a ``FoodFacts``
            rule (a label without the each base or the reverse, or a size that
            is not positive).
    """

    stock_base: StockBase
    each_label: str | None
    grams_per_each: Decimal | None = None
    ml_per_each: Decimal | None = None
    household_units: tuple[tuple[str, Decimal], ...] = ()

    def __post_init__(self) -> None:
        self.to_facts()

    def to_facts(self) -> FoodFacts:
        """Return the shape as unit-conversion facts.

        Returns:
            ``FoodFacts`` with the same base, label and sizes.

        Raises:
            ValueError: When the shape breaks a ``FoodFacts`` rule.
        """
        return FoodFacts(
            stock_base=self.stock_base,
            each_label=self.each_label,
            grams_per_each=self.grams_per_each,
            ml_per_each=self.ml_per_each,
            household_units=dict(self.household_units),
        )

    def describe_base(self) -> str:
        """Name the stock base in words, without the optional size facts.

        Returns:
            "grams", "millilitres" or "counted in <each_label>".
        """
        if self.stock_base == "g":
            return "grams"
        if self.stock_base == "ml":
            return "millilitres"
        return f"counted in {self.each_label}"


@dataclass(frozen=True)
class ParsedUnit:
    """A row unit read as a stock shape.

    ``per_unit`` is the stock amount in one of the row's units (1000 for kg
    into grams). ``guess`` explains the reading when it was a judgment call
    and is ``None`` when the unit has one meaning.
    """

    shape: StockShape
    per_unit: Decimal
    guess: str | None


@dataclass(frozen=True)
class Unparsed:
    """A row unit that no rule reads; ``reason`` says why, for the report."""

    reason: str


@dataclass(frozen=True)
class PlannedLot:
    """One lot to insert, built from one ``inventory_items`` row.

    ``id`` is the row's id, so cook events that deducted from the row resolve
    to this lot. ``quantity`` is in the food's stock base, exact and unrounded;
    ``source_quantity`` and ``source_unit`` are the row's original values.
    ``initial_quantity`` is not a field: a migrated lot's full amount is
    unknown, so the backfill always inserts it as NULL.
    """

    id: UUID
    quantity: Decimal
    source_quantity: Decimal
    source_unit: str
    expiration_date: date | None
    storage_location: str
    notes: str | None
    added_by: UUID | None
    created_at: datetime
    depleted_at: datetime | None
    depleted_reason: Literal["used"] | None


@dataclass(frozen=True)
class PlannedFood:
    """One food to insert, with its lots.

    ``name`` is the newest kept row's ``clean_name``; ``name_key`` equals what
    ``public.food_name_key(name)`` generates. ``lots`` is never empty and is
    sorted by creation time, then id.
    """

    name: str
    name_key: str
    category_id: UUID | None
    shape: StockShape
    lots: tuple[PlannedLot, ...]


@dataclass(frozen=True)
class Guess:
    """A judgment call the planner made, for a human to confirm.

    ``row_id`` names the row the guess is about, or is ``None`` when it is
    about the food as a whole (rows that disagree on name, category or size).
    """

    row_id: UUID | None
    food_name: str
    message: str


@dataclass(frozen=True)
class SkippedRow:
    """A row the plan does not migrate, with the reason it cannot."""

    row: InventoryRow
    reason: str


@dataclass(frozen=True)
class HouseholdPlan:
    """What the backfill would write for one household, and what it could not.

    ``foods`` are sorted by name key and ``skipped`` by creation time, then id.
    ``cooked_item_ids`` lists every item id the household's cook events
    deducted from, sorted; ``unresolved_cook_refs`` is the sorted subset that
    maps to no planned lot (the row was deleted or skipped).
    """

    household_id: UUID
    foods: tuple[PlannedFood, ...]
    guesses: tuple[Guess, ...]
    skipped: tuple[SkippedRow, ...]
    cooked_item_ids: tuple[UUID, ...]
    unresolved_cook_refs: tuple[UUID, ...]


@dataclass(frozen=True)
class BackfillPlan:
    """One plan per household that has inventory rows or cook events, by id."""

    households: tuple[HouseholdPlan, ...]


def parse_unit(text: str) -> ParsedUnit | Unparsed:
    """Read an ``inventory_items.unit`` string as a stock shape.

    Three rules apply in order: a unit the mass and volume tables know ("kg",
    "Cups"); a package ("Containers (63 g each)", "Container (14 servings)");
    bare words counted as each ("Slices"). Never converts between grams,
    millilitres and counts.

    Args:
        text: The unit as stored, in any case, singular or plural.

    Returns:
        ``ParsedUnit`` with the stock shape and the stock amount per unit, or
        ``Unparsed`` with a reason when no rule matches or a package count is
        not positive.
    """
    unit = _WHITESPACE.sub(" ", text).strip()
    if not unit:
        return Unparsed("unit is empty")
    measured = table_unit(unit)
    if measured is not None:
        base, per_unit = measured
        template = _MEASURED_GUESSES.get(normalize_unit(unit))
        size = f"{per_unit.quantize(Decimal('0.01'))} {base}"
        guess = None if template is None else template.format(size=size)
        return ParsedUnit(StockShape(base, None), per_unit, guess)
    package = _PACKAGE.match(unit)
    if package is not None:
        return _parse_package(unit, *package.groups())
    if _BARE_WORDS.match(unit) is not None:
        label = normalize_unit(unit)
        guess = (
            "counted as a generic each with no per-item size"
            if label == "each"
            else None
        )
        return ParsedUnit(StockShape("each", label), Decimal(1), guess)
    return Unparsed(f"unit {text!r} matches no known unit or package pattern")


def plan_backfill(
    rows: Iterable[InventoryRow], cook_refs: Iterable[CookRef] = ()
) -> BackfillPlan:
    """Plan how inventory rows become foods and lots, household by household.

    Groups each household's rows by ``name_key``. Rows of one food must share
    a stock base. Live rows (not depleted, quantity above 0) vote and the base
    most of them hold wins; ties go to the earliest created voter, and every
    row votes when none is live. Rows in another base are skipped, never
    converted. Rows with a negative or non-finite quantity, an unparsable
    unit, or a name that is empty or over the foods name limit are skipped.
    A zero-quantity or already-depleted row becomes a depleted lot ("used").

    Args:
        rows: Every ``inventory_items`` row to plan, depleted ones included.
        cook_refs: Item ids referenced by ``cook_events.deductions``;
            duplicates are fine.

    Returns:
        The deterministic plan: the same rows always give the same plan.
    """
    rows_by_household: dict[UUID, list[InventoryRow]] = defaultdict(list)
    for row in rows:
        rows_by_household[row.household_id].append(row)
    cooked_by_household: dict[UUID, set[UUID]] = defaultdict(set)
    for ref in cook_refs:
        cooked_by_household[ref.household_id].add(ref.item_id)
    households = sorted(rows_by_household.keys() | cooked_by_household.keys())
    return BackfillPlan(
        tuple(
            _plan_household(
                household_id,
                rows_by_household[household_id],
                cooked_by_household[household_id],
            )
            for household_id in households
        )
    )


def _parse_package(
    unit: str, label: str, count: str, inner: str, each: str | None
) -> ParsedUnit | Unparsed:
    amount = Decimal(count)
    if amount <= 0:
        return Unparsed(f"unit {unit!r} has a package count that is not positive")
    each_label = normalize_unit(label)
    measured = table_unit(inner)
    if measured is not None:
        base, per_inner = measured
        size = amount * per_inner
        shape = StockShape(
            "each",
            each_label,
            grams_per_each=size if base == "g" else None,
            ml_per_each=size if base == "ml" else None,
        )
        guess = None if each else f"read as {count} {inner} each"
        return ParsedUnit(shape, Decimal(1), guess)
    if each:
        return Unparsed(f"unit {unit!r} has a package size unit no table knows")
    inner_key = normalize_unit(inner)
    if inner_key in (each_label, "each"):
        return Unparsed(f"unit {unit!r} names a package of itself")
    shape = StockShape(
        "each", each_label, household_units=((inner_key, Decimal(1) / amount),)
    )
    return ParsedUnit(
        shape, Decimal(1), f"read as 1 {inner_key} = 1/{count} {each_label}"
    )


def _plan_household(
    household_id: UUID, rows: list[InventoryRow], cooked: set[UUID]
) -> HouseholdPlan:
    skipped: list[SkippedRow] = []
    groups: dict[str, list[tuple[InventoryRow, ParsedUnit]]] = defaultdict(list)
    for row in rows:
        problem = _row_problem(row)
        if problem is None:
            parsed = parse_unit(row.unit)
            if isinstance(parsed, ParsedUnit):
                groups[row.name_key].append((row, parsed))
                continue
            problem = parsed.reason
        skipped.append(SkippedRow(row, problem))

    foods: list[PlannedFood] = []
    guesses: list[Guess] = []
    for key in sorted(groups):
        food, food_guesses, conflicts = _plan_food(key, groups[key])
        foods.append(food)
        guesses.extend(food_guesses)
        skipped.extend(conflicts)

    lot_ids = {lot.id for food in foods for lot in food.lots}
    cooked_ids = tuple(sorted(cooked))
    return HouseholdPlan(
        household_id=household_id,
        foods=tuple(foods),
        guesses=tuple(guesses),
        skipped=tuple(sorted(skipped, key=lambda s: (s.row.created_at, s.row.id))),
        cooked_item_ids=cooked_ids,
        unresolved_cook_refs=tuple(i for i in cooked_ids if i not in lot_ids),
    )


def _row_problem(row: InventoryRow) -> str | None:
    if not row.clean_name or not row.name_key:
        return "name is empty"
    if len(row.clean_name) > _MAX_FOOD_NAME_LENGTH:
        return f"name is longer than {_MAX_FOOD_NAME_LENGTH} characters"
    if not row.quantity.is_finite():
        return f"quantity {row.quantity} is not a finite number"
    if row.quantity < 0:
        return f"quantity {row.quantity} is negative"
    return None


def _plan_food(
    key: str, members: list[tuple[InventoryRow, ParsedUnit]]
) -> tuple[PlannedFood, list[Guess], list[SkippedRow]]:
    members = sorted(members, key=lambda m: (m[0].created_at, m[0].id))
    shape, size_messages = _pick_shape(members)
    kept = [m for m in members if _base(m[1].shape) == _base(shape)]
    name = kept[-1][0].clean_name

    food_messages = []
    names = sorted({row.clean_name for row, _ in kept})
    if len(names) > 1:
        food_messages.append(
            f"rows are named {', '.join(map(repr, names))}; using {name!r}"
        )
    categories = [row.category_id for row, _ in kept if row.category_id is not None]
    if len(set(categories)) > 1:
        food_messages.append("rows disagree on category; using the newest row's")
    guesses = [Guess(None, name, m) for m in food_messages + size_messages]

    lots = []
    for row, parsed in kept:
        lot, lot_messages = _plan_lot(row, parsed)
        lots.append(lot)
        guesses += [Guess(row.id, name, message) for message in lot_messages]

    conflicts = [
        SkippedRow(
            row,
            f"stock shape {parsed.shape.describe_base()} differs from food "
            f"{name!r}, which is {shape.describe_base()}",
        )
        for row, parsed in members
        if _base(parsed.shape) != _base(shape)
    ]
    category_id = categories[-1] if categories else None
    food = PlannedFood(name, key, category_id, shape, tuple(lots))
    return food, guesses, conflicts


def _pick_shape(
    members: list[tuple[InventoryRow, ParsedUnit]],
) -> tuple[StockShape, list[str]]:
    """Vote on a food's stock base, then gather its size facts.

    ``members`` is sorted oldest first. Only live rows vote, so a used-up row
    in another unit cannot outvote stock on the shelf. Each size fact comes
    from the newest live row that states it, else the newest depleted one;
    a fact the rows state differently becomes a message for a guess.
    """
    voters = [m for m in members if _is_live(m[0])] or members
    # Counter keeps first-seen order, so max() breaks ties toward the
    # earliest created voter's base.
    votes = Counter(_base(parsed.shape) for _, parsed in voters)
    stock_base, each_label = max(votes, key=votes.__getitem__)
    newest_live_first = sorted(
        (m for m in members if _base(m[1].shape) == (stock_base, each_label)),
        key=lambda m: (_is_live(m[0]), m[0].created_at, m[0].id),
        reverse=True,
    )

    chosen: dict[_Fact, Decimal] = {}
    units_by_value: dict[_Fact, dict[Decimal, str]] = defaultdict(dict)
    for row, parsed in newest_live_first:
        for fact, value in _size_facts(parsed.shape):
            chosen.setdefault(fact, value)
            units_by_value[fact].setdefault(value, row.unit)
    messages = [
        f"rows disagree on the {_fact_words(fact, each_label)} "
        f"({', '.join(map(repr, units.values()))}); "
        f"using {units[chosen[fact]]!r}"
        for fact, units in units_by_value.items()
        if len(units) > 1
    ]
    shape = StockShape(
        stock_base,
        each_label,
        grams_per_each=chosen.get("grams"),
        ml_per_each=chosen.get("millilitres"),
        household_units=tuple(
            sorted((f.word, v) for f, v in chosen.items() if isinstance(f, _UnitSize))
        ),
    )
    return shape, messages


def _plan_lot(row: InventoryRow, parsed: ParsedUnit) -> tuple[PlannedLot, list[str]]:
    """Build one row's lot and the guesses its unit and depletion took."""
    messages = [] if parsed.guess is None else [f"unit {row.unit!r} {parsed.guess}"]
    depleted_at = row.depleted_at
    if depleted_at is not None:
        messages.append("already used up; kept as a depleted lot")
    elif row.quantity == 0:
        depleted_at = row.updated_at
        messages.append("quantity is 0; kept as a lot used up at its last update")
    lot = PlannedLot(
        id=row.id,
        quantity=row.quantity * parsed.per_unit,
        source_quantity=row.quantity,
        source_unit=row.unit,
        expiration_date=row.expiration_date,
        storage_location=row.storage_location,
        notes=row.notes if row.notes and row.notes.strip() else None,
        added_by=row.added_by,
        created_at=row.created_at,
        depleted_at=depleted_at,
        depleted_reason=None if depleted_at is None else "used",
    )
    return lot, messages


def _is_live(row: InventoryRow) -> bool:
    return row.depleted_at is None and row.quantity > 0


def _base(shape: StockShape) -> tuple[StockBase, str | None]:
    return shape.stock_base, shape.each_label


def _size_facts(shape: StockShape) -> list[tuple[_Fact, Decimal]]:
    facts: list[tuple[_Fact, Decimal]] = [
        (_UnitSize(word), size) for word, size in shape.household_units
    ]
    if shape.grams_per_each is not None:
        facts.append(("grams", shape.grams_per_each))
    if shape.ml_per_each is not None:
        facts.append(("millilitres", shape.ml_per_each))
    return facts


def _fact_words(fact: _Fact, each_label: str | None) -> str:
    if isinstance(fact, _UnitSize):
        return f"size of a {fact.word}"
    return f"{fact} per {each_label}"
