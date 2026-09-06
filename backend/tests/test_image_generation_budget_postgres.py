"""Acceptance tests for the image reservation ledger and RPC."""

# ruff: noqa: E501
from __future__ import annotations

import os
import subprocess
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest

DSN = os.environ.get("FRESHPLATE_TEST_POSTGRES_DSN", "")
pytestmark = pytest.mark.skipif(not DSN, reason="Requires disposable local PostgreSQL")
MIGRATION = Path(__file__).parents[2] / "supabase/migrations/20260906073059_image_generation_budget.sql"


def run(sql: str, dsn: str = DSN, *, check: bool = True):
    result = subprocess.run(["psql", "-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-d", dsn], input=sql, text=True, capture_output=True, timeout=10)
    if check:
        assert result.returncode == 0, result.stderr
    return result


@pytest.fixture(scope="module")
def db():
    name = "freshplate_image_" + uuid.uuid4().hex
    run(f"CREATE DATABASE {name}")
    dsn = DSN.rsplit("/", 1)[0] + "/" + name
    try:
        run("CREATE EXTENSION pgcrypto;", dsn)
        run("DO $$ BEGIN CREATE ROLE anon NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$; DO $$ BEGIN CREATE ROLE authenticated NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;", dsn)
        run(MIGRATION.read_text(encoding="utf-8"), dsn)
        yield dsn
    finally:
        run(f"DROP DATABASE {name} WITH (FORCE)")


def reserve(db: str, cost: int, cap: int, *, role: str = "service_role") -> str:
    result = run(f"SET ROLE {role}; SELECT * FROM public.reserve_image_asset('recipe', 'key-{uuid.uuid4()}', {cost}, {cap});", db)
    return result.stdout.strip()


def test_exact_boundary_and_global_cap(db):
    first = reserve(db, 100, 200)
    second = reserve(db, 100, 200)
    blocked = reserve(db, 1, 200)
    assert first and second
    assert blocked == ""
    assert run("SELECT reserved_cost_microusd FROM public.image_generation_months", db).stdout.strip() == "200"


def test_same_asset_is_idempotent_and_failed_asset_cannot_retry(db):
    key = "same-key"
    first = run(
        f"SET ROLE service_role; SELECT * FROM public.reserve_image_asset('ingredient', '{key}', 10, 300);",
        db,
    )
    second = run(
        f"SET ROLE service_role; SELECT * FROM public.reserve_image_asset('ingredient', '{key}', 10, 300);",
        db,
    )
    assert "|t|reserved" in first.stdout
    assert "|f|reserved" in second.stdout


def test_invalid_cost_or_cap_is_not_billable(db):
    result = run("SET ROLE service_role; SELECT * FROM public.reserve_image_asset('recipe', 'invalid', 0, 100);", db)
    assert result.stdout.strip() == ""
    assert run("SELECT coalesce(sum(reserved_cost_microusd), 0) FROM public.image_generation_months", db).stdout.strip() == "210"


def test_concurrent_same_asset_reserves_once(db):
    key = "concurrent-key"
    sql = f"SET ROLE service_role; SELECT * FROM public.reserve_image_asset('ingredient', '{key}', 10, 1000);"
    with ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(lambda _: run(sql, db).stdout.strip(), range(4)))
    assert sum("|t|reserved" in result for result in results) == 1
    assert sum("|f|reserved" in result for result in results) == 3


@pytest.mark.parametrize("role", ["anon", "authenticated"])
def test_public_roles_cannot_reserve_or_read(db, role):
    result = run(
        f"SET ROLE {role}; SELECT * FROM public.reserve_image_asset('recipe', 'denied', 1, 100);",
        db,
        check=False,
    )
    assert result.returncode != 0
    table = run(f"SET ROLE {role}; SELECT * FROM public.image_assets;", db, check=False)
    assert table.returncode != 0
