"""Contract tests for the demo reset RPC against a disposable local database."""
# ruff: noqa: E501

from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit
from uuid import uuid4

import pytest

DSN = os.environ.get("FRESHPLATE_TEST_POSTGRES_DSN", "")
pytestmark = pytest.mark.skipif(not DSN, reason="Requires disposable local PostgreSQL")
MIGRATION = (
    Path(__file__).parents[2]
    / "supabase/migrations/20260905130000_add_demo_household_reset.sql"
)


def sql(value: object) -> str:
    return "'" + str(value).replace("'", "''") + "'"


@pytest.fixture(scope="module")
def db():
    parsed = urlsplit(DSN)
    assert parsed.hostname in {"localhost", "127.0.0.1", "::1"}
    admin = urlunsplit(parsed._replace(path="/postgres"))
    name = "freshplate_seed_test_" + uuid4().hex

    def run(dsn: str, statement: str, check: bool = True):
        result = subprocess.run(
            ["psql", "-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-d", dsn],
            input=statement,
            text=True,
            capture_output=True,
            timeout=10,
        )
        if check:
            assert result.returncode == 0, result.stderr
        return result

    run(admin, f"CREATE DATABASE {name}")
    dsn = urlunsplit(parsed._replace(path="/" + name))
    try:
        run(
            dsn,
            """
            CREATE TABLE households (id uuid PRIMARY KEY, created_by uuid NOT NULL, is_demo boolean NOT NULL DEFAULT false);
            CREATE TABLE household_members (household_id uuid, user_id uuid, role text);
            CREATE TABLE food_categories (id uuid PRIMARY KEY, name text UNIQUE);
            CREATE TABLE inventory_items (
                id uuid DEFAULT gen_random_uuid() PRIMARY KEY, household_id uuid,
                added_by uuid, name text NOT NULL, quantity numeric NOT NULL,
                unit text NOT NULL, category_id uuid, expiration_date date,
                storage_location text NOT NULL, notes text
            );
            INSERT INTO food_categories VALUES
              ('00000000-0000-0000-0000-000000000001','Produce'),
              ('00000000-0000-0000-0000-000000000002','Dairy & Eggs'),
              ('00000000-0000-0000-0000-000000000003','Meat & Seafood'),
              ('00000000-0000-0000-0000-000000000004','Frozen'),
              ('00000000-0000-0000-0000-000000000005','Grains & Bread'),
              ('00000000-0000-0000-0000-000000000006','Canned Goods'),
              ('00000000-0000-0000-0000-000000000007','Condiments'),
              ('00000000-0000-0000-0000-000000000008','Beverages');
        """,
        )
        run(dsn, MIGRATION.read_text())
        yield dsn, run
    finally:
        run(admin, f"DROP DATABASE {name} WITH (FORCE)")


def call(db, household, user, items, role="service_role", check=True):
    dsn, run = db
    statement = (
        f"SET ROLE {role}; SELECT public.reset_demo_household({sql(household)}::uuid, "
        f"{sql(user)}::uuid, {sql(json.dumps(items))}::jsonb);"
    )
    return run(dsn, statement, check=check)


def items(count=20, category="Produce"):
    return [
        {
            "name": f"Demo item {i}",
            "quantity": 1,
            "unit": "each",
            "category": category,
            "expiration_days": i,
            "storage_location": "fridge",
        }
        for i in range(count)
    ]


def test_reset_repeat_and_isolate_households(db):
    user = "00000000-0000-0000-0000-000000000001"
    target = "00000000-0000-0000-0000-000000000011"
    other = "00000000-0000-0000-0000-000000000012"
    db[1](
        db[0],
        f"INSERT INTO households VALUES ({sql(target)},{sql(user)},true),({sql(other)},{sql(user)},true); INSERT INTO household_members VALUES ({sql(target)},{sql(user)},'owner'),({sql(other)},{sql(user)},'owner');",  # noqa: E501
    )
    db[1](
        db[0],
        f"INSERT INTO inventory_items(household_id,added_by,name,quantity,unit,storage_location) VALUES ({sql(other)},{sql(user)},'Keep',1,'each','fridge');",  # noqa: E501
    )
    assert call(db, target, user, items()).stdout.strip() == "20"
    first = db[1](
        db[0],
        f"SELECT count(*), min(expiration_date), max(expiration_date) FROM inventory_items WHERE household_id={sql(target)}",  # noqa: E501
    ).stdout.strip()
    assert call(db, target, user, items()).stdout.strip() == "20"
    assert (
        db[1](
            db[0],
            f"SELECT count(*), min(expiration_date), max(expiration_date) FROM inventory_items WHERE household_id={sql(target)}",  # noqa: E501
        ).stdout.strip()
        == first
    )
    assert (
        db[1](
            db[0],
            f"SELECT count(*) FROM inventory_items WHERE household_id={sql(other)}",
        ).stdout.strip()
        == "1"
    )


def test_invalid_target_payload_and_role_leave_data_unchanged(db):
    user = "00000000-0000-0000-0000-000000000001"
    target = "00000000-0000-0000-0000-000000000021"
    db[1](
        db[0],
        f"INSERT INTO households VALUES ({sql(target)},{sql(user)},true); INSERT INTO household_members VALUES ({sql(target)},{sql(user)},'owner'); INSERT INTO inventory_items(household_id,added_by,name,quantity,unit,storage_location) VALUES ({sql(target)},{sql(user)},'Original',1,'each','fridge');",  # noqa: E501
    )
    assert call(db, target, user, items(14), check=False).returncode != 0
    assert call(db, target, user, items(), role="public", check=False).returncode != 0
    assert (
        db[1](
            db[0], f"SELECT name FROM inventory_items WHERE household_id={sql(target)}"
        ).stdout.strip()
        == "Original"
    )
