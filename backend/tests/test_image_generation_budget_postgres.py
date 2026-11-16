"""Exercise the image generation ledger against disposable local PostgreSQL."""

from __future__ import annotations

import os
import subprocess
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest

DSN = os.environ.get("FRESHPLATE_TEST_POSTGRES_DSN", "")
pytestmark = pytest.mark.skipif(not DSN, reason="Requires disposable local PostgreSQL")
MIGRATIONS = [
    Path(__file__).parents[2] / "supabase/migrations" / name
    for name in (
        "20260906073059_image_generation_budget.sql",
        "20261114120000_add_image_asset_lifecycle.sql",
    )
]
USER = "00000000-0000-0000-0000-000000000001"
OTHER = "00000000-0000-0000-0000-000000000002"
USER_CAP = 1000
MAX_ATTEMPTS = 2
RETRY_AFTER = 900
LEASE = 180


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
        # Stand-ins for Supabase roles, its default grants of new public
        # functions to client roles, and the Storage bucket catalog.
        run(
            """
            DO $$ BEGIN CREATE ROLE anon NOLOGIN;
                EXCEPTION WHEN duplicate_object THEN NULL; END $$;
            DO $$ BEGIN CREATE ROLE authenticated NOLOGIN;
                EXCEPTION WHEN duplicate_object THEN NULL; END $$;
            DO $$ BEGIN CREATE ROLE service_role NOLOGIN BYPASSRLS;
                EXCEPTION WHEN duplicate_object THEN NULL; END $$;
            ALTER DEFAULT PRIVILEGES IN SCHEMA public
                GRANT ALL ON FUNCTIONS TO anon, authenticated;
            GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
            CREATE SCHEMA storage;
            CREATE TABLE storage.buckets (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                public BOOLEAN,
                file_size_limit BIGINT,
                allowed_mime_types TEXT[]
            );
        """,
            dsn,
        )
        run(MIGRATIONS[0].read_text(encoding="utf-8"), dsn)
        # A row from the reserve-only function, which has no lease.
        run(
            "SELECT * FROM public.reserve_image_asset('recipe', 'legacy', 1, 1000000)",
            dsn,
        )
        run(MIGRATIONS[1].read_text(encoding="utf-8"), dsn)
        run(
            "DELETE FROM public.image_assets; "
            "UPDATE public.image_generation_months SET reserved_cost_microusd = 0",
            dsn,
        )
        yield dsn
    finally:
        run(f"DROP DATABASE {name} WITH (FORCE)")


def claim(
    db: str,
    key: str,
    cost: int = 10,
    cap: int = 100,
    *,
    kind: str = "recipe",
    user: str = USER,
    user_cap: int = USER_CAP,
) -> list[str]:
    output = run(
        "SET ROLE service_role; SELECT outcome, asset_id, reservation_id, object_path "
        f"FROM public.claim_image_asset('{kind}', '{key}', '{user}', {cost}, {cap}, "
        f"{user_cap}, {MAX_ATTEMPTS}, {RETRY_AFTER}, {LEASE});",
        db,
    ).stdout.strip()
    return output.split("|")


def settle(db: str, asset_id: str, reservation_id: str, path: str = "recipe/a.webp"):
    return run(
        "SET ROLE service_role; SELECT public.settle_image_asset("
        f"'{asset_id}', '{reservation_id}', '{path}');",
        db,
    ).stdout.strip()


def release(db: str, asset_id: str, reservation_id: str, *, refund: bool) -> str:
    return run(
        "SET ROLE service_role; SELECT public.release_image_asset("
        f"'{asset_id}', '{reservation_id}', {str(refund).lower()});",
        db,
    ).stdout.strip()


def reserved_total(db: str) -> int:
    return int(
        run(
            "SELECT coalesce(sum(reserved_cost_microusd), 0) "
            "FROM public.image_generation_months",
            db,
        ).stdout
    )


def user_total(db: str, user: str = USER) -> int:
    return int(
        run(
            "SELECT coalesce(sum(reserved_cost_microusd), 0) "
            f"FROM public.image_generation_user_months WHERE user_id = '{user}'",
            db,
        ).stdout
    )


def age_asset(db: str, asset_id: str, seconds: int) -> None:
    run(
        "UPDATE public.image_assets SET "
        f"updated_at = updated_at - interval '{seconds} seconds', "
        f"lease_expires_at = lease_expires_at - interval '{seconds} seconds' "
        f"WHERE id = '{asset_id}'",
        db,
    )


def test_first_claim_reserves_and_settle_makes_it_ready(db):
    outcome, asset, reservation, path = claim(db, "dish")
    assert outcome == "claimed" and reservation and not path
    assert reserved_total(db) == 10
    assert settle(db, asset, reservation, "recipe/dish.webp") == "t"
    assert claim(db, "dish") == ["ready", asset, "", "recipe/dish.webp"]
    assert reserved_total(db) == 10


def test_claim_in_progress_is_not_charged_again(db):
    _, asset, _, _ = claim(db, "dish")
    assert claim(db, "dish") == ["in_progress", asset, "", ""]
    assert reserved_total(db) == 10


def test_settle_and_release_need_the_current_reservation(db):
    _, asset, reservation, _ = claim(db, "dish")
    wrong = str(uuid.uuid4())
    assert settle(db, asset, wrong) == "f"
    assert release(db, asset, wrong, refund=True) == "f"
    assert reserved_total(db) == 10
    assert settle(db, asset, reservation) == "t"
    assert release(db, asset, reservation, refund=True) == "f"
    assert reserved_total(db) == 10


def test_exactly_at_cap_reserves_and_one_more_microdollar_does_not(db):
    assert claim(db, "first", 60, 100)[0] == "claimed"
    assert claim(db, "second", 40, 100)[0] == "claimed"
    assert claim(db, "over", 1, 100) == ["budget_exhausted", "", "", ""]
    assert reserved_total(db) == 100
    assert run("SELECT count(*) FROM public.image_assets", db).stdout.strip() == "2"


def test_just_over_cap_is_rejected_without_a_partial_charge(db):
    assert claim(db, "first", 60, 100)[0] == "claimed"
    assert claim(db, "second", 41, 100)[0] == "budget_exhausted"
    assert reserved_total(db) == 60


def test_refund_returns_budget_and_charged_failure_keeps_it(db):
    _, refunded, refunded_reservation, _ = claim(db, "refunded", 60, 100)
    assert release(db, refunded, refunded_reservation, refund=True) == "t"
    assert reserved_total(db) == 0
    _, kept, kept_reservation, _ = claim(db, "kept", 60, 100)
    assert release(db, kept, kept_reservation, refund=False) == "t"
    assert reserved_total(db) == 60
    assert claim(db, "next", 41, 100)[0] == "budget_exhausted"


def test_one_user_cannot_spend_past_their_cap(db):
    assert claim(db, "first", 60, 1000, user_cap=100)[0] == "claimed"
    assert claim(db, "second", 40, 1000, user_cap=100)[0] == "claimed"
    assert claim(db, "third", 1, 1000, user_cap=100)[0] == "budget_exhausted"
    assert claim(db, "third", 1, 1000, user=OTHER, user_cap=100)[0] == "claimed"
    assert (user_total(db), user_total(db, OTHER), reserved_total(db)) == (100, 1, 101)


def test_refund_credits_the_requesters_cap(db):
    _, asset, reservation, _ = claim(db, "dish", 60, 1000, user_cap=100)
    release(db, asset, reservation, refund=True)
    assert user_total(db) == 0
    assert claim(db, "other", 100, 1000, user_cap=100)[0] == "claimed"


def test_refunded_attempts_do_not_use_up_the_attempt_limit(db):
    _, asset, _, _ = claim(db, "flaky")
    for _ in range(MAX_ATTEMPTS + 1):
        age_asset(db, asset, RETRY_AFTER + 1)
        outcome, _, reservation, _ = claim(db, "flaky")
        assert outcome == "claimed"
        release(db, asset, reservation, refund=True)
    assert reserved_total(db) == 10


def test_month_rollover_starts_a_fresh_cap(db):
    run(
        """
        INSERT INTO public.image_generation_months(month_start, reserved_cost_microusd)
        VALUES (
            (date_trunc('month', timezone('utc', now())) - interval '1 month')::date,
            100
        )
        """,
        db,
    )
    assert claim(db, "this-month", 100, 100)[0] == "claimed"
    assert reserved_total(db) == 200


def test_refund_after_rollover_credits_the_reservation_month(db):
    _, asset, reservation, _ = claim(db, "late", 60, 100)
    run(
        """
        INSERT INTO public.image_generation_months(month_start, reserved_cost_microusd)
        VALUES ('2000-01-01', 60);
        UPDATE public.image_assets SET reservation_month = '2000-01-01';
        UPDATE public.image_generation_months SET reserved_cost_microusd = 0
         WHERE month_start <> '2000-01-01';
        """,
        db,
    )
    assert release(db, asset, reservation, refund=True) == "t"
    assert reserved_total(db) == 0


def test_failed_key_waits_for_cooldown_then_retries_up_to_max(db):
    _, asset, first, _ = claim(db, "flaky")
    release(db, asset, first, refund=False)
    assert claim(db, "flaky") == ["failed", asset, "", ""]
    assert claim(db, "flaky", 10, 100, user=OTHER) == ["failed", asset, "", ""]
    age_asset(db, asset, RETRY_AFTER + 1)
    outcome, same_asset, second, _ = claim(db, "flaky")
    assert (outcome, same_asset) == ("claimed", asset) and second != first
    release(db, asset, second, refund=False)
    age_asset(db, asset, RETRY_AFTER + 1)
    assert claim(db, "flaky")[0] == "failed"
    assert reserved_total(db) == 20


def test_expired_lease_counts_as_a_charged_attempt(db):
    _, asset, first, _ = claim(db, "crashed")
    age_asset(db, asset, LEASE + 1)
    outcome, _, second, _ = claim(db, "crashed")
    assert outcome == "claimed" and second != first
    assert settle(db, asset, first) == "f"
    age_asset(db, asset, LEASE + 1)
    assert claim(db, "crashed")[0] == "failed"
    assert reserved_total(db) == 20


def test_budget_exhausted_retry_keeps_the_failed_asset(db):
    _, asset, reservation, _ = claim(db, "retry", 60, 100)
    release(db, asset, reservation, refund=False)
    age_asset(db, asset, RETRY_AFTER + 1)
    assert claim(db, "retry", 60, 100) == ["budget_exhausted", asset, "", ""]
    status = run(
        f"SELECT status, attempts FROM public.image_assets WHERE id = '{asset}'", db
    ).stdout.strip()
    assert status == "failed|1"


def test_concurrent_same_key_reserves_once(db):
    with ThreadPoolExecutor(max_workers=8) as pool:
        rows = list(pool.map(lambda _: claim(db, "shared"), range(8)))
    assert sorted(row[0] for row in rows) == ["claimed"] + ["in_progress"] * 7
    assert len({row[1] for row in rows}) == 1
    assert reserved_total(db) == 10


def test_concurrent_distinct_keys_cannot_exceed_global_cap(db):
    with ThreadPoolExecutor(max_workers=8) as pool:
        rows = list(pool.map(lambda i: claim(db, f"asset-{i}", 10, 30), range(8)))
    assert sum(row[0] == "claimed" for row in rows) == 3
    assert reserved_total(db) == 30


def test_recipe_and_ingredient_share_the_cap(db):
    assert claim(db, "dish", 60, 100, kind="recipe")[0] == "claimed"
    assert claim(db, "tomato", 40, 100, kind="ingredient")[0] == "claimed"
    assert claim(db, "basil", 1, 100, kind="ingredient")[0] == "budget_exhausted"


@pytest.mark.parametrize(
    "args",
    [
        f"'recipe', 'k', '{USER}', 0, 100, 100, 2, 900, 180",
        f"'recipe', 'k', '{USER}', 10, 0, 100, 2, 900, 180",
        f"'recipe', 'k', '{USER}', 10, 100, 0, 2, 900, 180",
        "'recipe', 'k', NULL, 10, 100, 100, 2, 900, 180",
        f"'recipe', '', '{USER}', 10, 100, 100, 2, 900, 180",
        f"'photo', 'k', '{USER}', 10, 100, 100, 2, 900, 180",
        f"'recipe', 'k', '{USER}', 10, 100, 100, 0, 900, 180",
        f"'recipe', 'k', '{USER}', 10, 100, 100, 2, -1, 180",
        f"'recipe', 'k', '{USER}', 10, 100, 100, 2, 900, 0",
    ],
)
def test_invalid_claims_raise_and_charge_nothing(db, args):
    result = run(
        f"SET ROLE service_role; SELECT * FROM public.claim_image_asset({args})",
        db,
        check=False,
    )
    assert result.returncode != 0
    assert "invalid image claim" in result.stderr
    assert reserved_total(db) == 0


def test_unbounded_reserve_function_is_dropped(db):
    result = run(
        "SELECT to_regprocedure('public.reserve_image_asset(text,text,bigint,bigint)')",
        db,
    )
    assert result.stdout.strip() == ""


def test_private_bucket_holds_webp_images(db):
    row = run(
        "SELECT public, allowed_mime_types FROM storage.buckets "
        "WHERE id = 'generated-images'",
        db,
    ).stdout.strip()
    assert row == "f|{image/webp}"


@pytest.mark.parametrize("role", ["anon", "authenticated"])
@pytest.mark.parametrize(
    "sql",
    [
        "SELECT * FROM public.claim_image_asset("
        f"'recipe', 'k', '{USER}', 1, 100, 100, 2, 900, 180)",
        f"SELECT public.settle_image_asset('{uuid.uuid4()}', '{uuid.uuid4()}', 'p')",
        f"SELECT public.release_image_asset('{uuid.uuid4()}', '{uuid.uuid4()}', true)",
        "SELECT * FROM public.image_assets",
        "SELECT * FROM public.image_generation_months",
        "SELECT * FROM public.image_generation_user_months",
        "INSERT INTO public.image_generation_months(month_start) VALUES ('2000-01-01')",
    ],
)
def test_client_roles_cannot_touch_the_ledger(db, role, sql):
    assert run(f"SET ROLE {role}; {sql}", db, check=False).returncode != 0
