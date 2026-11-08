"""Inventory backfill dry run against a disposable PostgreSQL cluster (#108).

Proves the CLI writes nothing, that the plan fits every foods and lots
constraint when inserted, and that food names and keys follow the database's
own whitespace and case rules.
"""

# ruff: noqa: E501

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path
from typing import NamedTuple
from urllib.parse import urlsplit, urlunsplit
from uuid import UUID, uuid4

import psycopg
import pytest
from psycopg import sql
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from app.inventory.backfill import HouseholdPlan, plan_backfill
from app.scripts.dry_run_inventory_backfill import read_inventory

DSN = os.environ.get("FRESHPLATE_TEST_POSTGRES_DSN", "")
pytestmark = pytest.mark.skipif(not DSN, reason="Requires disposable local PostgreSQL")
BACKEND = Path(__file__).parents[1]
MIGRATIONS = BACKEND.parent / "supabase/migrations"
USER = UUID("00000000-0000-0000-0000-000000000001")
TABLES = ("inventory_items", "cook_events", "foods", "food_units", "lots")


@pytest.fixture(scope="module")
def database_dsn():
    parsed = urlsplit(DSN)
    assert parsed.hostname in {"localhost", "127.0.0.1", "::1"}
    database = "freshplate_backfill_test_" + uuid4().hex
    name = sql.Identifier(database)
    with psycopg.connect(DSN, autocommit=True) as admin:
        admin.execute("""
            DO $$ BEGIN
              IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF;
              IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
            END $$;
        """)
        admin.execute(sql.SQL("CREATE DATABASE {}").format(name))
    dsn = urlunsplit(parsed._replace(path="/" + database))
    try:
        with psycopg.connect(dsn, autocommit=True) as db:
            # Stand-ins for the Supabase objects the migrations reference.
            db.execute("""
              GRANT USAGE ON SCHEMA public TO anon, authenticated;
              CREATE EXTENSION pgcrypto;
              CREATE SCHEMA auth;
              CREATE TABLE auth.users(id uuid primary key);
              CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
              CREATE TABLE public.households(id uuid primary key);
              CREATE TABLE public.household_members(
                household_id uuid references public.households(id) on delete cascade,
                user_id uuid references auth.users(id)
              );
            """)
            db.execute("INSERT INTO auth.users VALUES (%s)", (USER,))
            for migration in (
                "20260329180000_create_inventory_tables.sql",
                "20260516224316_fix_household_members_rls.sql",
                "20260905071100_add_cook_deduction_rpc.sql",
                "20261107120000_add_foods_and_lots.sql",
            ):
                db.execute((MIGRATIONS / migration).read_text())
        yield dsn
    finally:
        with psycopg.connect(DSN, autocommit=True) as admin:
            admin.execute(sql.SQL("DROP DATABASE {} WITH (FORCE)").format(name))


@pytest.fixture
def db(database_dsn):
    with psycopg.connect(
        database_dsn, autocommit=True, row_factory=dict_row
    ) as connection:
        yield connection


def add_household(db: psycopg.Connection) -> UUID:
    household_id = uuid4()
    db.execute("INSERT INTO households VALUES (%s)", (household_id,))
    db.execute("INSERT INTO household_members VALUES (%s, %s)", (household_id, USER))
    return household_id


class SeedRow(NamedTuple):
    label: str
    name: str
    quantity: str
    unit: str
    age: str
    depleted_ago: str | None


def seed_household(db: psycopg.Connection) -> tuple[UUID, dict[str, UUID]]:
    """Insert a household with today's unit variety; return its id and row ids by label."""
    household_id = add_household(db)
    category = db.execute(
        "SELECT id FROM food_categories WHERE name = 'Dairy & Eggs'"
    ).fetchone()["id"]
    rows = [
        SeedRow("eggs1", "Eggs", "6", "item", "3 days", None),
        SeedRow("eggs2", "eggs ", "12", "item", "2 days", None),
        SeedRow("milk", "Milk", "1", "l", "2 days", None),
        SeedRow("rice_g", "Rice", "500", "g", "5 days", None),
        SeedRow("rice_cups", "Rice", "2", "Cups", "1 day", None),
        SeedRow("yogurt", "Greek  Yogurt", "3", "Containers (63 g each)", "1 day", None),
        SeedRow("soup", "Soup", "1.5", "Container (14 servings)", "1 day", None),
        SeedRow("butter", "Butter", "0", "oz", "4 days", None),
        SeedRow("jam", "Jam", "1", "2 jars?", "1 day", None),
        SeedRow("used", "Bread", "2", "Slices", "6 days", "1 day"),
    ]
    ids = {}
    for r in rows:
        ids[r.label] = db.execute(
            """
            INSERT INTO inventory_items (household_id, category_id, added_by, name, quantity, unit,
                expiration_date, storage_location, notes, created_at, updated_at, depleted_at)
            VALUES (%s, %s, %s, %s, %s, %s, current_date + 3, 'fridge', 'note',
                now() - %s::interval, now() - %s::interval, now() - %s::interval)
            RETURNING id
            """,
            (household_id, category, USER, r.name, r.quantity, r.unit, r.age, r.age, r.depleted_ago),
        ).fetchone()["id"]
    recipe_id = str(uuid4())
    deductions = [
        {"inventory_item_id": str(ids[label]), "confirmed_amount": 1}
        for label in ("eggs1", "used", "rice_cups")
    ]
    db.execute(
        """
        INSERT INTO cook_events (household_id, user_id, recipe_id, operation_id, recipe_snapshot,
            deductions, request_deductions)
        VALUES (%s, %s, %s, gen_random_uuid(), %s, %s, '[]'::jsonb)
        """,
        (
            household_id,
            USER,
            recipe_id,
            Jsonb({"recipe_id": recipe_id}),
            Jsonb(deductions),
        ),
    )
    return household_id, ids


def fingerprint(db: psycopg.Connection) -> dict[str, str]:
    """Return each table's row count and content checksum."""
    return {
        table: db.execute(
            sql.SQL(
                "SELECT count(*) || ':' || coalesce(md5(string_agg(t::text, ',' ORDER BY t::text)), '') AS f FROM public.{} t"
            ).format(sql.Identifier(table))
        ).fetchone()["f"]
        for table in TABLES
    }


def plan_household(db: psycopg.Connection, household_id: UUID) -> HouseholdPlan:
    rows, refs, _ = read_inventory(db, household_id)
    (household,) = plan_backfill(rows, refs).households
    return household


def insert_plan(db: psycopg.Connection, household: HouseholdPlan) -> None:
    """Insert one household's plan in a transaction; initial_quantity stays NULL.

    A test-only stand-in for the real writer that #109 adds. It proves the
    plan's shape fits the foods, food_units and lots constraints and triggers.
    """
    with db.transaction():
        for food in household.foods:
            shape = food.shape
            food_id = db.execute(
                """
                INSERT INTO foods (household_id, category_id, name, stock_base, each_label,
                    grams_per_each, ml_per_each)
                VALUES (%s, %s, %s, %s, %s, %s, %s) RETURNING id
                """,
                (
                    household.household_id,
                    food.category_id,
                    food.name,
                    shape.stock_base,
                    shape.each_label,
                    shape.grams_per_each,
                    shape.ml_per_each,
                ),
            ).fetchone()["id"]
            for word, size in shape.household_units:
                db.execute(
                    "INSERT INTO food_units (food_id, household_id, unit_key, base_per_unit) VALUES (%s, %s, %s, %s)",
                    (food_id, household.household_id, word, size),
                )
            for lot in food.lots:
                db.execute(
                    """
                    INSERT INTO lots (id, food_id, household_id, quantity, initial_quantity,
                        expiration_date, storage_location, depleted_at, depleted_reason, added_by,
                        notes, created_at)
                    VALUES (%s, %s, %s, %s, NULL, %s, %s, %s, %s, %s, %s, %s)
                    """,
                    (
                        lot.id,
                        food_id,
                        household.household_id,
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


def column(db: psycopg.Connection, query: str, *params: object) -> list:
    return [next(iter(r.values())) for r in db.execute(query, params).fetchall()]


def test_cli_prints_the_plan_and_writes_nothing(db, database_dsn):
    household_id, ids = seed_household(db)
    before = fingerprint(db)

    result = subprocess.run(
        [
            sys.executable,
            "-m",
            "app.scripts.dry_run_inventory_backfill",
            "--household",
            str(household_id),
        ],
        cwd=BACKEND,
        env={**os.environ, "BACKFILL_DATABASE_URL": database_dsn},
        text=True,
        capture_output=True,
        timeout=60,
    )

    assert result.returncode == 0, result.stderr
    report = result.stdout
    assert f"Household {household_id}: 10 rows, 7 foods, 8 lots" in report
    assert "eggs: counted in each" in report
    assert "Greek Yogurt: counted in container, 63 g each" in report
    assert f"lot {ids['milk']}  1000 ml  from 1 l" in report
    assert f"lot {ids['used']}  2 slice  from 2 Slices" in report
    assert "depleted (used)" in report
    assert f"row {ids['rice_cups']} 'Rice'" in report
    assert f"row {ids['jam']} 'Jam'" in report
    assert f"1 of 3 cooked item ids resolve to no lot: {ids['rice_cups']}" in report
    assert fingerprint(db) == before


def test_cli_refuses_without_an_explicit_database():
    env = {k: v for k, v in os.environ.items() if k != "BACKFILL_DATABASE_URL"}

    result = subprocess.run(
        [sys.executable, "-m", "app.scripts.dry_run_inventory_backfill"],
        cwd=BACKEND,
        env=env,
        text=True,
        capture_output=True,
        timeout=60,
    )

    assert result.returncode != 0
    assert "BACKFILL_DATABASE_URL" in result.stderr


def test_inserted_plan_satisfies_every_constraint_and_resolves_cook_events(db):
    household_id, ids = seed_household(db)
    household = plan_household(db, household_id)

    insert_plan(db, household)

    planned_ids = {lot.id for food in household.foods for lot in food.lots}
    assert (
        set(column(db, "SELECT id FROM lots WHERE household_id = %s", household_id))
        == planned_ids
    )
    assert planned_ids <= set(ids.values())
    assert column(
        db,
        "SELECT count(*) FROM lots WHERE household_id = %s AND initial_quantity IS NOT NULL",
        household_id,
    ) == [0]
    assert column(
        db,
        'SELECT name_key FROM foods WHERE household_id = %s ORDER BY name_key COLLATE "C"',
        household_id,
    ) == [food.name_key for food in household.foods]
    (serving,) = column(
        db,
        "SELECT base_per_unit FROM food_units WHERE household_id = %s AND unit_key = 'serving'",
        household_id,
    )
    assert round(serving * 14, 9) == 1
    unresolved = column(
        db,
        """
        SELECT (line->>'inventory_item_id')::uuid FROM cook_events ce, jsonb_array_elements(ce.deductions) line
        WHERE ce.household_id = %s
          AND NOT EXISTS (SELECT 1 FROM lots l WHERE l.id = (line->>'inventory_item_id')::uuid)
        """,
        household_id,
    )
    assert unresolved == list(household.unresolved_cook_refs) == [ids["rice_cups"]]


@pytest.mark.parametrize(
    "names",
    [
        ["Green Onions", "green onions", " GREEN\tONIONS ", "Green Onions"],
        # Python treats U+0085 and U+001F as whitespace; this database does not.
        ["Green Onions", "Green\u0085Onions"],
        ["Milk", "Milk\x1f"],
    ],
)
def test_foods_take_their_names_and_keys_from_the_database(db, names):
    household_id = add_household(db)
    for offset, name in enumerate(names):
        db.execute(
            "INSERT INTO inventory_items (household_id, name, quantity, unit, created_at) VALUES (%s, %s, 1, 'item', now() + make_interval(secs => %s))",
            (household_id, name, offset),
        )
    sql_keys = {
        db.execute("SELECT public.food_name_key(%s) AS k", (name,)).fetchone()["k"]
        for name in names
    }

    household = plan_household(db, household_id)
    insert_plan(db, household)

    assert len(household.foods) == len(sql_keys)
    stored = db.execute(
        'SELECT name, name_key FROM foods WHERE household_id = %s ORDER BY name_key COLLATE "C"',
        (household_id,),
    ).fetchall()
    assert [(f.name, f.name_key) for f in household.foods] == [
        (r["name"], r["name_key"]) for r in stored
    ]
    assert column(
        db, "SELECT count(*) FROM lots WHERE household_id = %s", household_id
    ) == [len(names)]
