"""Move inventory_items rows into foods and lots, safely re-runnable.

Usage::

    BACKFILL_DATABASE_URL=postgresql://... \\
        python -m app.scripts.run_inventory_backfill [--household UUID]

Reads inventory the way ``app.scripts.dry_run_inventory_backfill`` does, plans
it with ``app.inventory.backfill.plan_backfill``, writes the plan, checks that
cook events still resolve, and commits, all in one REPEATABLE READ transaction.
Review the dry run's report first; this report lists only what was written and
what was not.

Each lot keeps its ``inventory_items`` id, and a lot that already exists is
never rewritten, so a second run writes nothing and a run after new rows
appear moves only those rows. ``inventory_items`` is left untouched.

A re-run never reconciles. A row changed after its lot was written keeps the
lot as it was, a deleted row keeps its lot, and a row deleted and added again
under a new id becomes a second lot. Foods are matched by name key only, so a
row named after a food that was since renamed creates a food under the old
name.
"""

from __future__ import annotations

import argparse
import os
from dataclasses import dataclass
from uuid import UUID

import psycopg
from psycopg.rows import dict_row

from app.inventory.backfill import (
    BackfillPlan,
    HouseholdPlan,
    PlannedFood,
    PlannedLot,
    plan_backfill,
)
from app.scripts.dry_run_inventory_backfill import read_inventory

_INSERT_FOOD_SQL = """
    INSERT INTO public.foods (household_id, category_id, name, stock_base, each_label,
        grams_per_each, ml_per_each)
    VALUES (%s, %s, %s, %s, %s, %s, %s)
    ON CONFLICT (household_id, name_key) DO NOTHING
    RETURNING id
"""
_INSERT_LOT_SQL = """
    INSERT INTO public.lots (id, food_id, household_id, quantity, initial_quantity,
        expiration_date, storage_location, depleted_at, depleted_reason, added_by,
        notes, created_at)
    VALUES (%s, %s, %s, %s, NULL, %s, %s, %s, %s, %s, %s, %s)
    ON CONFLICT (id) DO NOTHING
"""
_UNRESOLVED_COOK_REFS_SQL = """
    SELECT DISTINCT (line->>'inventory_item_id')::uuid AS item_id
    FROM public.cook_events ce, jsonb_array_elements(ce.deductions) AS line
    WHERE ce.household_id = %s
      AND line ? 'inventory_item_id'
      AND NOT EXISTS (
          SELECT 1 FROM public.lots l
          WHERE l.id = (line->>'inventory_item_id')::uuid
            AND l.household_id = ce.household_id)
    ORDER BY 1
"""


@dataclass(frozen=True)
class UnmovedLot:
    """A planned lot the writer left out, with the reason for the report."""

    lot_id: UUID
    food_name: str
    reason: str


@dataclass(frozen=True)
class HouseholdMove:
    """What one run wrote for one household, and what it left out.

    Attributes:
        household_id: The household the counts describe.
        foods_created: Foods this run inserted.
        foods_reused: Foods that already existed and were missing planned
            lots, including those whose lots were left out.
        lots_inserted: Lots this run inserted.
        lots_already_moved: Planned lots that already existed by id. Their
            rows are never rewritten.
        not_moved: Planned lots left out because their food already exists in
            a different stock base, is whole units only and a lot is
            fractional, or was merged or archived.
        planner_skipped: Rows the plan itself does not migrate.
        unresolved_cook_refs: Item ids the household's cook events deducted
            from that match no lot after the writes, sorted.
    """

    household_id: UUID
    foods_created: int
    foods_reused: int
    lots_inserted: int
    lots_already_moved: int
    not_moved: tuple[UnmovedLot, ...]
    planner_skipped: int
    unresolved_cook_refs: tuple[UUID, ...]


def apply_plan(
    connection: psycopg.Connection, plan: BackfillPlan
) -> tuple[HouseholdMove, ...]:
    """Write a backfill plan into foods, food_units and lots.

    Runs in the caller's transaction and never commits. Only planned lots
    whose id is not already in ``lots`` are written, so running the same plan
    again writes nothing. A food is created when no food of the same name key
    exists; its category, sizes and ``food_units`` rows are written only then,
    as ``add_lot`` does. An existing food whose stock base or each label
    differs from the plan, that is merged or archived, or that is whole units
    only while a missing lot is fractional, gets none of its missing lots;
    amounts are never converted or rounded. Each food's ``lock_foods`` lock
    is held before its lots are inserted. Inserted lots keep the row's id, so
    cook event deductions still resolve, and leave ``initial_quantity`` NULL.

    Args:
        connection: An open connection inside a transaction, on a database
            with the foods-and-lots migration. REPEATABLE READ is expected,
            so the plan's reads and these writes see one snapshot.
        plan: The plan from ``plan_backfill``.

    Returns:
        One ``HouseholdMove`` per planned household, in plan order.

    Raises:
        psycopg.Error: When a write fails, including a serialization failure
            when a concurrent writer changed the same food or lot. The caller
            must roll back.
    """
    with connection.cursor(row_factory=dict_row) as cursor:
        return tuple(
            _apply_household(cursor, household) for household in plan.households
        )


def render(plan: BackfillPlan, moves: tuple[HouseholdMove, ...]) -> str:
    """Format what a committed run wrote as a short plain-text report.

    Per household: a summary line, the lots left out with reasons, the rows
    the plan skipped with reasons, and the cook event check. Guesses are
    omitted; the dry run reports them.

    Args:
        plan: The plan that was written.
        moves: The result of ``apply_plan`` for that plan.

    Returns:
        The report, ending with a newline.
    """
    lines = ["Inventory backfill committed."]
    if not moves:
        lines += ["", "No inventory rows."]
    for household, move in zip(plan.households, moves, strict=True):
        lines += [""] + _render_household(household, move)
    return "\n".join(lines) + "\n"


def main(argv: list[str] | None = None) -> None:
    """Run the backfill for one or every household and print the report.

    Reads, plans, writes and checks in one REPEATABLE READ transaction on the
    database named by ``BACKFILL_DATABASE_URL``, then commits and prints.

    Args:
        argv: Command-line arguments; ``None`` reads ``sys.argv``. Accepts
            ``--household UUID`` to limit the run to one household.

    Raises:
        SystemExit: When ``BACKFILL_DATABASE_URL`` is unset, ``--household`` is
            not a UUID, or any database statement fails. A failed run is
            rolled back and writes nothing.
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
            connection.isolation_level = psycopg.IsolationLevel.REPEATABLE_READ
            with connection.transaction():
                rows, refs, _ = read_inventory(connection, args.household)
                plan = plan_backfill(rows, refs)
                moves = apply_plan(connection, plan)
    except psycopg.Error as exc:
        raise SystemExit(
            f"Inventory backfill failed and was rolled back "
            f"({type(exc).__name__}, SQLSTATE {exc.sqlstate})."
        ) from None
    print(render(plan, moves), end="")


def _apply_household(cursor: psycopg.Cursor, household: HouseholdPlan) -> HouseholdMove:
    created = reused = inserted = already_moved = 0
    not_moved: list[UnmovedLot] = []
    for food in household.foods:
        existing = {
            r["id"]
            for r in cursor.execute(
                "SELECT id FROM public.lots WHERE id = ANY(%s)",
                ([lot.id for lot in food.lots],),
            )
        }
        already_moved += len(existing)
        missing = [lot for lot in food.lots if lot.id not in existing]
        if not missing:
            continue
        food_id, food_created = _find_or_create_food(
            cursor, household.household_id, food
        )
        created += food_created
        reused += not food_created
        cursor.execute("SELECT public.lock_foods(ARRAY[%s]::uuid[])", (food_id,))
        problem = (
            None if food_created else _reuse_problem(cursor, food_id, food, missing)
        )
        if problem is not None:
            not_moved += [UnmovedLot(lot.id, food.name, problem) for lot in missing]
            continue
        for lot in missing:
            # Under READ COMMITTED, a concurrent run's lot committed after the id
            # check conflicts here; REPEATABLE READ raises a serialization error.
            if _insert_lot(cursor, household.household_id, food_id, lot):
                inserted += 1
            else:
                already_moved += 1
    unresolved = tuple(
        r["item_id"]
        for r in cursor.execute(_UNRESOLVED_COOK_REFS_SQL, (household.household_id,))
    )
    return HouseholdMove(
        household_id=household.household_id,
        foods_created=created,
        foods_reused=reused,
        lots_inserted=inserted,
        lots_already_moved=already_moved,
        not_moved=tuple(not_moved),
        planner_skipped=len(household.skipped),
        unresolved_cook_refs=unresolved,
    )


def _find_or_create_food(
    cursor: psycopg.Cursor, household_id: UUID, food: PlannedFood
) -> tuple[UUID, bool]:
    shape = food.shape
    created = cursor.execute(
        _INSERT_FOOD_SQL,
        (
            household_id,
            food.category_id,
            food.name,
            shape.stock_base,
            shape.each_label,
            shape.grams_per_each,
            shape.ml_per_each,
        ),
    ).fetchone()
    if created is None:
        existing = cursor.execute(
            "SELECT id FROM public.foods WHERE household_id = %s AND name_key = %s",
            (household_id, food.name_key),
        ).fetchone()
        return existing["id"], False
    for word, size in shape.household_units:
        cursor.execute(
            """
            INSERT INTO public.food_units
                (food_id, household_id, unit_key, base_per_unit)
            VALUES (%s, %s, %s, %s)
            ON CONFLICT DO NOTHING
            """,
            (created["id"], household_id, word, size),
        )
    return created["id"], True


def _reuse_problem(
    cursor: psycopg.Cursor, food_id: UUID, food: PlannedFood, lots: list[PlannedLot]
) -> str | None:
    # FOR SHARE blocks a concurrent stock base change until this transaction ends.
    existing = cursor.execute(
        """
        SELECT stock_base::text, each_label, whole_units_only, merged_into_id,
            archived_at
        FROM public.foods WHERE id = %s FOR SHARE
        """,
        (food_id,),
    ).fetchone()
    if existing["merged_into_id"] is not None:
        return f"food {food.name!r} was merged into another food"
    if existing["archived_at"] is not None:
        return f"food {food.name!r} is archived"
    if (existing["stock_base"], existing["each_label"]) != (
        food.shape.stock_base,
        food.shape.each_label,
    ):
        stored = existing["stock_base"] + (
            f" ({existing['each_label']})" if existing["each_label"] else ""
        )
        return (
            f"food {food.name!r} is stored as {stored}, but the plan reads these "
            f"rows as {food.shape.describe_base()}; not converted"
        )
    if existing["whole_units_only"] and any(
        lot.quantity != lot.quantity.to_integral_value() for lot in lots
    ):
        return f"food {food.name!r} is counted in whole units only; not rounded"
    return None


def _insert_lot(
    cursor: psycopg.Cursor, household_id: UUID, food_id: UUID, lot: PlannedLot
) -> bool:
    cursor.execute(
        _INSERT_LOT_SQL,
        (
            lot.id,
            food_id,
            household_id,
            lot.quantity,
            lot.expiration_date,
            lot.storage_location,
            lot.depleted_at,
            lot.depleted_reason,
            lot.added_by,
            lot.notes,
            lot.created_at,
        ),
    )
    return cursor.rowcount == 1


def _render_household(household: HouseholdPlan, move: HouseholdMove) -> list[str]:
    lines = [
        f"Household {move.household_id}: "
        f"foods {move.foods_created} created, {move.foods_reused} reused; "
        f"lots {move.lots_inserted} inserted, "
        f"{move.lots_already_moved} already moved, {len(move.not_moved)} not moved; "
        f"{move.planner_skipped} rows skipped by the plan"
    ]
    if move.not_moved:
        lines.append("  Not moved:")
        lines += [
            f"    lot {u.lot_id} {u.food_name}: {u.reason}" for u in move.not_moved
        ]
    if household.skipped:
        lines.append("  Skipped by the plan:")
        lines += [
            f"    row {s.row.id} {s.row.name!r}: {s.reason}" for s in household.skipped
        ]
    cooked, unresolved = len(household.cooked_item_ids), move.unresolved_cook_refs
    if unresolved:
        ids = ", ".join(str(i) for i in unresolved)
        lines.append(
            f"  Cook events: {len(unresolved)} of {cooked} cooked item ids "
            f"resolve to no lot: {ids}"
        )
    else:
        lines.append(f"  Cook events: all {cooked} cooked item ids resolve to lots.")
    return lines


if __name__ == "__main__":
    main()
