"""Contract tests for the demo reset RPC and CLI against a disposable local database."""
# ruff: noqa: E501

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path
from uuid import uuid4

import pytest

from tests.pg_support import (
    DB,
    DSN,
    FOODS_MIGRATIONS,
    OTHER,
    USER,
    add_lot,
    disposable_database,
    q,
)

pytestmark = pytest.mark.skipif(not DSN, reason="Requires disposable local PostgreSQL")
BACKEND = Path(__file__).parents[1]
# Timestamped names sort into the order the migrations ship in.
MIGRATIONS = tuple(sorted((
    *FOODS_MIGRATIONS,
    "20260905130000_add_demo_household_reset.sql",
    "20261113120000_add_cook_recipe_v2.sql",
    "20261113130000_add_cook_event_lines.sql",
    "20261116100000_reset_demo_household_into_foods_and_lots.sql",
    "20261117200000_drop_inventory_items_and_cook_recipe.sql",
)))
# Every column the app shows for a seeded food or batch. Ids and timestamps are
# left out because each reset creates fresh rows.
KITCHEN = """
    SELECT coalesce(json_agg(row ORDER BY row::text), '[]') FROM (
      SELECT f.name, c.name AS category, f.stock_base, f.each_label, f.whole_units_only,
             f.grams_per_each, l.quantity, l.initial_quantity,
             l.expiration_date - current_date AS expires_in,
             current_date - l.opened_at::date AS opened_days_ago, l.storage_location,
             l.notes, l.depleted_at, l.added_by,
             (SELECT json_object_agg(u.unit_key, u.base_per_unit) FROM food_units u
              WHERE u.food_id = f.id) AS units
      FROM foods f
      LEFT JOIN food_categories c ON c.id = f.category_id
      LEFT JOIN lots l ON l.food_id = f.id
      WHERE f.household_id = {household}
    ) row
"""


@pytest.fixture(scope="module")
def database():
    yield from disposable_database(MIGRATIONS)


def demo_household(db: DB, owner: str = USER, *, designated: bool = True) -> str:
    household_id = str(uuid4())
    db.run(
        f"INSERT INTO households VALUES ({q(household_id)}, {q(owner)});"
        f"INSERT INTO household_members VALUES ({q(household_id)}, {q(owner)}, 'owner');"
    )
    if designated:
        db.run(f"INSERT INTO demo_households(household_id) VALUES ({q(household_id)});")
    return household_id


def run_script(module: str, *args: str, env: dict[str, str]):
    return subprocess.run(
        [sys.executable, "-m", module, *args],
        cwd=BACKEND, env=os.environ | env, text=True, capture_output=True,
    )


def seed(db: DB, household_id: str, user: str = USER):
    return run_script(
        "app.scripts.seed_demo",
        env={"DEMO_DATABASE_URL": db.dsn, "DEMO_HOUSEHOLD_ID": household_id, "DEMO_USER_ID": user},
    )


def reset(db: DB, household_id: str, payload, *, user: str = USER, role: str = "service_role"):
    payload = "NULL" if payload is None else f"{q(json.dumps(payload))}::jsonb"
    return db.run(
        f"SELECT public.reset_demo_household({q(household_id)}, {q(user)}, {payload});",
        role=role,
        check=False,
    )


def kitchen(db: DB, household_id: str):
    return db.json(KITCHEN.format(household=q(household_id)))


def cook_event(db: DB, household_id: str) -> None:
    recipe = str(uuid4())
    db.run(
        "INSERT INTO cook_events(household_id, user_id, recipe_id, operation_id, recipe_snapshot, deductions, request_deductions) "
        f"VALUES ({q(household_id)}, {q(USER)}, {q(recipe)}, {q(uuid4())}, {q(json.dumps({'recipe_id': recipe}))}, '[]', '[]');"
    )


def cook_count(db: DB, household_id: str) -> str:
    return db.run(f"SELECT count(*) FROM cook_events WHERE household_id = {q(household_id)}")


def foods(count: int = 3) -> list[dict]:
    return [
        {
            "name": f"Demo food {i}",
            "category": "Produce",
            "stock_base": "g",
            "lots": [{"quantity": 100, "storage_location": "fridge", "expiration_days": 5}],
        }
        for i in range(count)
    ]


def test_seed_stocks_a_believable_kitchen(database):
    home = demo_household(database)

    result = seed(database, home)

    assert result.returncode == 0, result.stderr
    stock = database.json(
        f"""SELECT json_build_object(
              'foods', count(DISTINCT f.id),
              'locations', array_agg(DISTINCT l.storage_location ORDER BY l.storage_location),
              'bases', array_agg(DISTINCT f.stock_base::text ORDER BY f.stock_base::text),
              'expired', count(DISTINCT f.id) FILTER (WHERE l.expiration_date < current_date),
              'expiring_soon', count(DISTINCT f.id) FILTER (WHERE l.expiration_date BETWEEN current_date AND current_date + 3),
              'opened', count(*) FILTER (WHERE l.opened_at IS NOT NULL),
              'partly_used', count(*) FILTER (WHERE l.quantity < l.initial_quantity),
              'whole_unit_foods', count(DISTINCT f.id) FILTER (WHERE f.whole_units_only),
              'live_lots', count(*) FILTER (WHERE l.depleted_at IS NULL),
              'lots', count(*))
            FROM foods f JOIN lots l ON l.food_id = f.id WHERE f.household_id = {q(home)}"""
    )
    stacked = database.run(
        f"SELECT count(*) FROM food_stock WHERE household_id = {q(home)} AND lot_count > 1"
    )
    household_units = database.run(f"SELECT count(*) FROM food_units WHERE household_id = {q(home)}")
    assert 25 <= stock["foods"] <= 35
    assert stock["locations"] == ["freezer", "fridge", "pantry"]
    assert stock["bases"] == ["each", "g", "ml"]
    assert 2 <= stock["expired"] <= 5
    assert 2 <= stock["expiring_soon"] <= 6
    assert stock["opened"] >= 5
    assert stock["partly_used"] >= 5
    assert stock["whole_unit_foods"] >= 3
    assert stock["live_lots"] == stock["lots"]
    assert int(stacked) >= 2
    assert int(household_units) >= 1


def test_reset_after_reset_and_app_changes_restores_the_same_kitchen(database):
    home = demo_household(database)
    assert seed(database, home).returncode == 0
    first = kitchen(database, home)
    add_lot(database, home, "verify-extra", "g", 50, "pantry")
    cook_event(database, home)
    database.run(f"UPDATE foods SET name = 'verify-renamed' WHERE household_id = {q(home)} AND name = 'Milk';")
    database.run(
        f"UPDATE lots SET depleted_at = now(), depleted_reason = 'used' WHERE household_id = {q(home)} "
        f"AND id = (SELECT id FROM lots WHERE household_id = {q(home)} ORDER BY id LIMIT 1);"
    )

    result = seed(database, home)

    assert result.returncode == 0, result.stderr
    assert kitchen(database, home) == first
    assert cook_count(database, home) == "0"


def test_reset_leaves_other_households_untouched(database):
    home = demo_household(database)
    other = demo_household(database, OTHER)
    add_lot(database, other, "verify-keep", "g", 10, "pantry", user=OTHER)
    cook_event(database, other)

    assert seed(database, home).returncode == 0

    assert database.run(f"SELECT count(*) FROM lots WHERE household_id = {q(other)}") == "1"
    assert cook_count(database, other) == "1"


SEED_ERROR = "demo seed has a food with unknown keys, an unknown category or no lots"


@pytest.mark.parametrize(
    ("payload", "error"),
    [
        pytest.param(None, "non-empty array of foods", id="null"),
        pytest.param({"not": "a list"}, "non-empty array of foods", id="object"),
        pytest.param([], "non-empty array of foods", id="empty"),
        pytest.param([*foods(), {**foods(1)[0], "name": "Unknown aisle", "category": "Nope"}], SEED_ERROR, id="unknown-category"),
        pytest.param([*foods(), {**foods(1)[0], "name": "Typo", "expiry": 3}], SEED_ERROR, id="unknown-food-key"),
        pytest.param([*foods(), {**foods(1)[0], "name": "Null units", "units": None}], SEED_ERROR, id="null-units"),
        pytest.param([*foods(), {**foods(1)[0], "name": "No batches", "lots": []}], SEED_ERROR, id="no-lots"),
        pytest.param([*foods(), {**foods(1)[0], "name": "Bad batch", "lots": [{"quantity": 1, "storage_location": "fridge", "expires": 3}]}], SEED_ERROR, id="unknown-lot-key"),
        pytest.param([*foods(), {**foods(1)[0], "name": "Empty batch", "lots": [{"quantity": 0, "storage_location": "fridge"}]}], "violates check constraint", id="empty-lot"),
    ],
)
def test_invalid_payload_leaves_the_kitchen_unchanged(database, payload, error):
    home = demo_household(database)
    assert seed(database, home).returncode == 0
    before = kitchen(database, home)

    result = reset(database, home, payload)

    assert error in result.stderr
    assert kitchen(database, home) == before


OWNER_ERROR = "demo household and owner do not match"


@pytest.mark.parametrize(
    ("target", "user", "role", "error"),
    [
        pytest.param("demo", OTHER, "service_role", OWNER_ERROR, id="not-the-owner"),
        pytest.param("undesignated", USER, "service_role", OWNER_ERROR, id="not-a-demo-household"),
        pytest.param("demo", USER, "anon", "permission denied for function reset_demo_household", id="anon"),
        pytest.param("demo", USER, "authenticated", "permission denied for function reset_demo_household", id="authenticated"),
    ],
)
def test_reset_refuses_wrong_targets_and_client_roles(database, target, user, role, error):
    home = demo_household(database, designated=target == "demo")
    add_lot(database, home, "verify-original", "g", 10, "pantry")

    result = reset(database, home, foods(), user=user, role=role)

    assert error in result.stderr
    assert [row["name"] for row in kitchen(database, home)] == ["verify-original"]


def test_cli_reports_the_sqlstate_of_a_refused_reset(database):
    home = demo_household(database, designated=False)
    add_lot(database, home, "verify-original", "g", 10, "pantry")

    result = seed(database, home)

    assert result.returncode != 0
    assert "SQLSTATE 42501" in result.stderr
    assert database.dsn not in result.stdout + result.stderr
    assert [row["name"] for row in kitchen(database, home)] == ["verify-original"]


def test_clients_cannot_designate_a_demo_household(database):
    home = demo_household(database, designated=False)

    denied = database.run(
        f"INSERT INTO demo_households(household_id) VALUES ({q(home)});",
        role="authenticated", user=USER, check=False,
    )

    assert denied.returncode != 0
