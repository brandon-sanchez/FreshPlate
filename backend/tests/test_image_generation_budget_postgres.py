"""Exercise spending reservations against independent local PostgreSQL databases."""

from __future__ import annotations

import os
import subprocess
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest

DSN = os.environ.get("FRESHPLATE_TEST_POSTGRES_DSN", "")
pytestmark = pytest.mark.skipif(not DSN, reason="Requires disposable local PostgreSQL")
MIGRATION = (
    Path(__file__).parents[2]
    / "supabase/migrations/20260906073059_image_generation_budget.sql"
)


def run(sql: str, dsn: str = DSN, *, check: bool = True):
    result = subprocess.run(
        ["psql", "-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-d", dsn],
        input=sql,
        text=True,
        capture_output=True,
        timeout=10,
    )
    if check:
        assert result.returncode == 0, result.stderr
    return result


@pytest.fixture
def db():
    name = "freshplate_image_" + uuid.uuid4().hex
    run(f"CREATE DATABASE {name}")
    dsn = DSN.rsplit("/", 1)[0] + "/" + name
    try:
        run(
            """
            DO $$ BEGIN CREATE ROLE anon NOLOGIN;
                EXCEPTION WHEN duplicate_object THEN NULL; END $$;
            DO $$ BEGIN CREATE ROLE authenticated NOLOGIN;
                EXCEPTION WHEN duplicate_object THEN NULL; END $$;
            DO $$ BEGIN CREATE ROLE service_role NOLOGIN BYPASSRLS;
                EXCEPTION WHEN duplicate_object THEN NULL; END $$;
        """,
            dsn,
        )
        run(MIGRATION.read_text(encoding="utf-8"), dsn)
        yield dsn
    finally:
        run(f"DROP DATABASE {name} WITH (FORCE)")


def reserve(db: str, key: str, cost: int, cap: int) -> list[str]:
    output = run(
        "SET ROLE service_role; SELECT * FROM public.reserve_image_asset("
        f"'recipe', '{key}', {cost}, {cap});",
        db,
    ).stdout.strip()
    return output.split("|") if output else []


def reserved_total(db: str) -> int:
    return int(
        run(
            "SELECT coalesce(sum(reserved_cost_microusd), 0) "
            "FROM public.image_generation_months",
            db,
        ).stdout
    )


def test_exact_boundary_and_global_cap(db):
    assert reserve(db, "first", 100, 200)[2:] == ["t", "reserved"]
    assert reserve(db, "second", 100, 200)[2:] == ["t", "reserved"]
    assert reserve(db, "blocked", 1, 200) == []
    assert reserved_total(db) == 200


@pytest.mark.parametrize("status", ["reserved", "ready", "failed"])
def test_existing_asset_never_starts_another_billable_attempt(db, status):
    first = reserve(db, "same", 10, 100)
    run(f"UPDATE public.image_assets SET status = '{status}'", db)
    again = reserve(db, "same", 10, 100)
    assert again[:2] == first[:2]
    assert again[2:] == ["f", status]
    assert reserved_total(db) == 10


@pytest.mark.parametrize("cost,cap", [(0, 100), (-1, 100), (10, 0), (10, -1)])
def test_disabled_request_does_not_poison_future_generation(db, cost, cap):
    assert reserve(db, "later-enabled", cost, cap) == []
    assert run("SELECT count(*) FROM public.image_assets", db).stdout.strip() == "0"
    assert reserved_total(db) == 0
    assert reserve(db, "later-enabled", 10, 100)[2:] == ["t", "reserved"]
    assert reserved_total(db) == 10


def test_concurrent_same_asset_returns_one_reservation(db):
    with ThreadPoolExecutor(max_workers=8) as pool:
        rows = list(pool.map(lambda _: reserve(db, "shared", 10, 100), range(8)))
    assert len({tuple(row[:2]) for row in rows}) == 1
    assert sum(row[2] == "t" for row in rows) == 1
    assert sum(row[2] == "f" for row in rows) == 7
    assert reserved_total(db) == 10
    assert run("SELECT count(*) FROM public.image_assets", db).stdout.strip() == "1"


def test_concurrent_distinct_assets_cannot_exceed_global_cap(db):
    with ThreadPoolExecutor(max_workers=8) as pool:
        rows = list(pool.map(lambda i: reserve(db, f"asset-{i}", 10, 30), range(8)))
    assert sum(bool(row) for row in rows) == 3
    assert reserved_total(db) == 30
    assert run("SELECT count(*) FROM public.image_assets", db).stdout.strip() == "3"


def test_reservations_link_to_the_current_utc_month(db):
    reserve(db, "audited", 10, 100)
    assert (
        run(
            """
        SELECT reservation_month = date_trunc('month', now() AT TIME ZONE 'UTC')::date
        FROM public.image_assets
    """,
            db,
        ).stdout.strip()
        == "t"
    )
    assert (
        run(
            """
        SELECT a.reserved_cost_microusd = m.reserved_cost_microusd
        FROM public.image_assets a JOIN public.image_generation_months m
          ON a.reservation_month = m.month_start
    """,
            db,
        ).stdout.strip()
        == "t"
    )


@pytest.mark.parametrize("role", ["anon", "authenticated"])
def test_public_roles_cannot_reserve_or_read_ledgers(db, role):
    sql = "SELECT * FROM public.reserve_image_asset('recipe', 'denied', 1, 100)"
    assert run(f"SET ROLE {role}; {sql}", db, check=False).returncode != 0
    for table in ("image_assets", "image_generation_months"):
        result = run(f"SET ROLE {role}; SELECT * FROM public.{table}", db, check=False)
        assert result.returncode != 0
