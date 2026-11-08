"""Disposable PostgreSQL helpers shared by the database contract tests.

The tests run only when ``FRESHPLATE_TEST_POSTGRES_DSN`` points at a local
cluster. Each module creates its own throwaway database with Supabase
stand-ins (roles, ``auth.uid()``, households) and the migrations it needs.
"""

# SQL fixture strings are intentionally kept readable at their database shape.
# ruff: noqa: E501

from __future__ import annotations

import json
import os
import subprocess
from collections.abc import Iterator
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit
from uuid import uuid4

DSN = os.environ.get("FRESHPLATE_TEST_POSTGRES_DSN", "")
MIGRATIONS = Path(__file__).parents[2] / "supabase/migrations"
USER = "00000000-0000-0000-0000-000000000001"
OTHER = "00000000-0000-0000-0000-000000000002"
PSQL = ["psql", "-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-d"]


def q(value: object) -> str:
    return "'" + str(value).replace("'", "''") + "'"


def lit(value: object) -> str:
    if value is None:
        return "NULL"
    if isinstance(value, bool):
        return "true" if value else "false"
    return q(value)


def session_prefix(role: str | None, user: str | None) -> str:
    prefix = f"SET ROLE {role};" if role else ""
    if user:
        prefix += f"SET request.jwt.claim.sub = {q(user)};"
    return prefix


class DB:
    def __init__(self, dsn: str):
        self.dsn = dsn

    def run(
        self, sql: str, *, role: str | None = None, user: str | None = None, check=True
    ):
        result = subprocess.run(
            [*PSQL, self.dsn],
            input=session_prefix(role, user) + sql,
            text=True,
            capture_output=True,
            timeout=15,
        )
        if check:
            assert result.returncode == 0, result.stderr
            return result.stdout.strip()
        return result

    def json(self, sql: str, **kwargs):
        out = self.run(sql, **kwargs)
        return json.loads(out) if out else None


FOODS_MIGRATIONS = (
    "20260329180000_create_inventory_tables.sql",
    "20260516224316_fix_household_members_rls.sql",
    "20260905071100_add_cook_deduction_rpc.sql",
    "20261107120000_add_foods_and_lots.sql",
)


def disposable_database(migrations: tuple[str, ...]) -> Iterator[DB]:
    """Yield a DB with Supabase stand-ins and ``migrations`` applied, then drop it."""
    parsed = urlsplit(DSN)
    assert parsed.hostname in {"localhost", "127.0.0.1", "::1"}
    admin = DB(DSN)
    name = "freshplate_foods_lots_test_" + uuid4().hex
    admin.run("""
        DO $$ BEGIN
          IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF;
          IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
        END $$;
    """)
    admin.run(f"CREATE DATABASE {name}")
    db = DB(urlunsplit(parsed._replace(path="/" + name)))
    try:
        # Stand-ins for what Supabase provides, including its default grants of
        # every new public object to anon and authenticated.
        db.run(f"""
          ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated;
          ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated;
          ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated;
          GRANT USAGE ON SCHEMA public TO anon, authenticated;
          CREATE EXTENSION pgcrypto;
          CREATE SCHEMA auth;
          CREATE TABLE auth.users(id uuid primary key);
          CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
          GRANT USAGE ON SCHEMA auth TO anon, authenticated;
          GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated;
          CREATE TABLE public.households(id uuid primary key);
          CREATE TABLE public.household_members(
            household_id uuid references public.households(id) on delete cascade,
            user_id uuid references auth.users(id)
          );
          INSERT INTO auth.users VALUES ({q(USER)}), ({q(OTHER)});
        """)
        for migration in migrations:
            db.run((MIGRATIONS / migration).read_text())
        yield db
    finally:
        admin.run(f"DROP DATABASE {name} WITH (FORCE)")


def household(db: DB, member: str = USER) -> str:
    household_id = str(uuid4())
    db.run(
        f"INSERT INTO households VALUES ({q(household_id)}); INSERT INTO household_members VALUES ({q(household_id)}, {q(member)});"
    )
    return household_id


def add_lot_sql(
    household_id, name, stock_base, quantity, location="fridge", **kwargs
) -> str:
    args = {
        "p_household_id": household_id,
        "p_name": name,
        "p_stock_base": stock_base,
        "p_quantity": quantity,
        "p_storage_location": location,
        **{f"p_{key}": value for key, value in kwargs.items()},
    }
    named = ", ".join(f"{key} => {lit(value)}" for key, value in args.items())
    return f"SELECT public.add_lot({named});"


def add_lot(
    db: DB,
    household_id,
    name,
    stock_base,
    quantity,
    location="fridge",
    *,
    user=USER,
    role="authenticated",
    check=True,
    **kwargs,
):
    sql = add_lot_sql(household_id, name, stock_base, quantity, location, **kwargs)
    if check:
        return db.json(sql, role=role, user=user)
    return db.run(sql, role=role, user=user, check=False)
