"""Print how inventory_items rows would move into foods and lots, writing nothing.

Usage::

    BACKFILL_DATABASE_URL=postgresql://... \\
        python -m app.scripts.dry_run_inventory_backfill [--household UUID]

Reads every ``inventory_items`` row (depleted ones included) and the item ids
that ``cook_events.deductions`` reference, in one READ ONLY, REPEATABLE READ
transaction, then prints the plan from ``app.inventory.backfill`` for a human
to review. The database must already have the foods-and-lots migration,
because food name keys come from its ``public.food_name_key``.
"""

from __future__ import annotations

import argparse
import os
from datetime import date
from decimal import Decimal
from uuid import UUID

import psycopg
from psycopg.rows import dict_row

from app.inventory.backfill import (
    BackfillPlan,
    CookRef,
    HouseholdPlan,
    InventoryRow,
    PlannedLot,
    StockShape,
    plan_backfill,
)

# clean_name is the exact expression add_lot uses for a new food's name.
_ROWS_SQL = r"""
    SELECT id, household_id, name,
           btrim(regexp_replace(name, '\s+', ' ', 'g')) AS clean_name,
           public.food_name_key(name) AS name_key, quantity, unit, expiration_date,
           storage_location, category_id, notes, added_by, created_at, updated_at,
           depleted_at
    FROM public.inventory_items
    WHERE %(household)s::uuid IS NULL OR household_id = %(household)s::uuid
    ORDER BY household_id, created_at, id
"""
_COOK_REFS_SQL = """
    SELECT DISTINCT ce.household_id, (line->>'inventory_item_id')::uuid AS item_id
    FROM public.cook_events ce, jsonb_array_elements(ce.deductions) AS line
    WHERE line ? 'inventory_item_id'
      AND (%(household)s::uuid IS NULL OR ce.household_id = %(household)s::uuid)
    ORDER BY 1, 2
"""


def read_inventory(
    connection: psycopg.Connection, household: UUID | None
) -> tuple[list[InventoryRow], list[CookRef], date]:
    """Read the planner's inputs from the database.

    Runs its queries in the caller's transaction and writes nothing. Callers
    that need the rows and cook refs to agree open a REPEATABLE READ
    transaction first, as ``main`` does.

    Args:
        connection: An open psycopg connection to a database that has the
            foods-and-lots migration.
        household: One household id to read, or ``None`` for every household.

    Returns:
        The inventory rows with SQL-cleaned names and name keys, the cook
        event item references, and the database's current date.

    Raises:
        psycopg.Error: When a query fails.
    """
    params = {"household": household}
    with connection.cursor(row_factory=dict_row) as cursor:
        rows = [InventoryRow(**r) for r in cursor.execute(_ROWS_SQL, params)]
        refs = [CookRef(**r) for r in cursor.execute(_COOK_REFS_SQL, params)]
        today = cursor.execute("SELECT current_date AS today").fetchone()["today"]
    return rows, refs, today


def render(plan: BackfillPlan, today: date) -> str:
    """Format a plan as a plain-text report a human can review.

    Per household: a summary line, each food with its stock shape and one line
    per lot, every guess, every row that could not migrate, and the cook event
    check. Amounts are rounded to two places for display only.

    Args:
        plan: The plan from ``plan_backfill``.
        today: The date that decides which lots print as expired.

    Returns:
        The report, ending with a newline.
    """
    lines = [
        "Inventory backfill dry run: nothing was written.",
        "Every migrated lot's initial (full) amount is left unknown (null).",
    ]
    if not plan.households:
        lines += ["", "No inventory rows."]
    for household in plan.households:
        lines += [""] + _render_household(household, today)
    return "\n".join(lines) + "\n"


def main(argv: list[str] | None = None) -> None:
    """Print the backfill dry-run report for one or every household.

    Reads the database named by ``BACKFILL_DATABASE_URL`` in a single READ ONLY,
    REPEATABLE READ transaction: the server rejects any write in it, so the run
    cannot change data, and every query sees the same snapshot.

    Args:
        argv: Command-line arguments; ``None`` reads ``sys.argv``. Accepts
            ``--household UUID`` to limit the report to one household.

    Raises:
        SystemExit: When ``BACKFILL_DATABASE_URL`` is unset, ``--household`` is
            not a UUID, or the database read fails.
    """
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--household", type=UUID, help="limit to one household id")
    args = parser.parse_args(argv)
    dsn = os.environ.get("BACKFILL_DATABASE_URL")
    if not dsn:
        raise SystemExit(
            "Set BACKFILL_DATABASE_URL explicitly; refusing an implicit database."
        )
    try:
        with psycopg.connect(dsn) as connection:
            connection.read_only = True
            connection.isolation_level = psycopg.IsolationLevel.REPEATABLE_READ
            with connection.transaction():
                rows, refs, today = read_inventory(connection, args.household)
    except psycopg.Error as exc:
        raise SystemExit(
            f"Inventory read failed ({type(exc).__name__}, SQLSTATE {exc.sqlstate})."
        ) from None
    print(render(plan_backfill(rows, refs), today), end="")


def _render_household(household: HouseholdPlan, today: date) -> list[str]:
    lot_count = sum(len(food.lots) for food in household.foods)
    lines = [
        f"Household {household.household_id}: "
        f"{lot_count + len(household.skipped)} rows, {len(household.foods)} foods, "
        f"{lot_count} lots, {len(household.guesses)} guesses, "
        f"{len(household.skipped)} skipped"
    ]
    for food in household.foods:
        lines.append(f"  {food.name}: {_describe_shape(food.shape)}")
        unit = food.shape.each_label or food.shape.stock_base
        lines += [
            f"    lot {lot.id}  " + _render_lot(lot, unit, today) for lot in food.lots
        ]
    lines.append("  Guesses:")
    lines += [
        f"    {g.food_name}"
        + (f" (row {g.row_id})" if g.row_id else "")
        + f": {g.message}"
        for g in household.guesses
    ] or ["    none"]
    lines.append("  Could not migrate:")
    lines += [
        f"    row {s.row.id} {s.row.name!r} ({s.row.quantity} {s.row.unit!r}): "
        f"{s.reason}"
        for s in household.skipped
    ] or ["    none"]
    lines.append("  " + _render_cook_check(household))
    return lines


def _describe_shape(shape: StockShape) -> str:
    text = shape.describe_base()
    if shape.grams_per_each is not None:
        text += f", {_amount(shape.grams_per_each)} g each"
    if shape.ml_per_each is not None:
        text += f", {_amount(shape.ml_per_each)} ml each"
    for word, size in shape.household_units:
        text += f"; 1 {word} = {_fraction(size)} {shape.each_label}"
    return text


def _render_lot(lot: PlannedLot, unit: str, today: date) -> str:
    if lot.expiration_date is None:
        expiry = "no expiry"
    else:
        expired = " (expired)" if lot.expiration_date < today else ""
        expiry = f"expires {lot.expiration_date.isoformat()}{expired}"
    parts = [
        f"{_amount(lot.quantity)} {unit}",
        f"from {_amount(lot.source_quantity)} {lot.source_unit}",
        expiry,
        lot.storage_location,
    ]
    if lot.depleted_reason is not None:
        parts.append(f"depleted ({lot.depleted_reason})")
    return "  ".join(parts)


def _render_cook_check(household: HouseholdPlan) -> str:
    cooked, unresolved = household.cooked_item_ids, household.unresolved_cook_refs
    if not unresolved:
        return f"Cook events: all {len(cooked)} cooked item ids resolve to lots."
    ids = ", ".join(str(i) for i in unresolved)
    return (
        f"Cook events: {len(unresolved)} of {len(cooked)} cooked item ids "
        f"resolve to no lot: {ids}"
    )


def _amount(value: Decimal) -> str:
    text = f"{value.quantize(Decimal('0.01')):f}"
    return text.rstrip("0").rstrip(".") if "." in text else text


def _fraction(value: Decimal) -> str:
    denominator = (1 / value).quantize(Decimal("0.000001"))
    if denominator == denominator.to_integral_value():
        return f"1/{denominator:.0f}"
    return _amount(value)


if __name__ == "__main__":
    main()
