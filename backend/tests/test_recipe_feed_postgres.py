"""Real PostgreSQL contract tests, opt-in against a disposable local cluster.

Set FRESHPLATE_TEST_POSTGRES_DSN to a local administrator connection. The
fixture creates and drops its own database; it never contacts hosted Supabase.
Supabase's auth schema and roles are represented with the minimum real SQL
needed to exercise ownership policies, grants, row locks, and transactions.
"""

from __future__ import annotations

import json
import os
import subprocess
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit
from uuid import uuid4

import pytest

DSN = os.environ.get("FRESHPLATE_TEST_POSTGRES_DSN", "")
pytestmark = pytest.mark.skipif(
    not DSN, reason="Requires a disposable local PostgreSQL"
)
USER_A = "00000000-0000-0000-0000-000000000001"
USER_B = "00000000-0000-0000-0000-000000000002"
MIGRATIONS = Path(__file__).parents[2] / "supabase" / "migrations"


def _literal(value) -> str:
    return "'" + str(value).replace("'", "''") + "'"


def _json(value) -> str:
    return _literal(json.dumps(value)) + "::jsonb"


class Database:
    def __init__(self, dsn):
        self.dsn = dsn

    def run(self, sql, *, role=None, user=None, check=True):
        prefix = f"SET ROLE {role};" if role else ""
        if user:
            prefix += f"SET request.jwt.claim.sub = {_literal(user)};"
        result = subprocess.run(
            ["psql", "-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-d", self.dsn],
            input=prefix + sql,
            text=True,
            capture_output=True,
            timeout=10,
        )
        if check:
            assert result.returncode == 0, result.stderr
            return result.stdout.strip()
        return result

    def session(self, session_id):
        return json.loads(
            self.run(
                "SELECT row_to_json(s) FROM public.recipe_feed_sessions s "
                f"WHERE id = {_literal(session_id)}"
            )
        )

    def create(self, *, recipes=None):
        session_id = str(uuid4())
        session = {
            "id": session_id,
            "inventory": [],
            "preferences": {},
            "usable_items": [{"id": "spinach", "name": "Spinach"}],
            "retrieved_recipes": [{"id": index} for index in range(30)],
            "exclude_titles": ["Initial"],
            "retrieval_cursor": 5,
        }
        initial = recipes if recipes is not None else [_recipe("Initial")]
        self.run(
            f"SELECT * FROM public.create_recipe_feed_session({_literal(USER_A)}, "
            f"{_json(session)}, {_json(initial)})",
            role="service_role",
        )
        return session_id

    def claim(self, session_id, expected, claim_id=None, user=USER_A):
        claim_id = claim_id or str(uuid4())
        result = self.run(
            "SELECT row_to_json(s) FROM public.claim_recipe_feed_refill("
            f"{_literal(user)}, {_literal(session_id)}, "
            f"{expected}, {_literal(claim_id)}"
            ") s",
            role="service_role",
        )
        return json.loads(result) if result else None

    def finalize(self, session_id, claim_id, recipes, *, check=True):
        return self.run(
            "SELECT row_to_json(s) FROM public.finalize_recipe_feed_refill("
            f"{_literal(USER_A)}, {_literal(session_id)}, {_literal(claim_id)}, "
            f"{_json(recipes)}, ARRAY['Initial','Next'], 10) s",
            role="service_role",
            check=check,
        )


def _recipe(title):
    return {"recipe_id": str(uuid4()), "title": title}


@pytest.fixture(scope="module")
def database():
    parsed = urlsplit(DSN)
    assert parsed.hostname in {"localhost", "127.0.0.1", "::1"}, "Local PostgreSQL only"
    admin = Database(DSN)
    name = "freshplate_feed_test_" + uuid4().hex
    admin.run("""
        DO $$ BEGIN
            IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'anon') THEN
                CREATE ROLE anon NOLOGIN;
            END IF;
            IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'authenticated') THEN
                CREATE ROLE authenticated NOLOGIN;
            END IF;
            IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'service_role') THEN
                CREATE ROLE service_role NOLOGIN BYPASSRLS;
            END IF;
        END $$;
    """)
    admin.run(f"CREATE DATABASE {name}")
    db = Database(urlunsplit(parsed._replace(path="/" + name)))
    try:
        db.run("""
            CREATE SCHEMA auth;
            CREATE TABLE auth.users (id uuid PRIMARY KEY);
            CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
                SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
            $$;
            GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
            GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated, service_role;
        """)
        db.run(
            f"INSERT INTO auth.users VALUES ({_literal(USER_A)}), ({_literal(USER_B)})"
        )
        for filename in (
            "20260804220854_recipe_feed_sessions.sql",
            "20260805190000_recipe_feed_retrieval_cursor.sql",
            "20260905063603_secure_atomic_recipe_feed_refills.sql",
        ):
            db.run((MIGRATIONS / filename).read_text())
        yield db
    finally:
        admin.run(f"DROP DATABASE {name} WITH (FORCE)")


def test_client_mutations_and_rpc_execution_are_denied(database):
    session_id = database.create()
    for role in ("anon", "authenticated"):
        for sql in (
            "UPDATE public.recipe_feed_sessions SET generation_runs=0, has_more=true",
            "INSERT INTO public.recipe_feed_sessions(id,user_id) "
            f"VALUES ({_literal(uuid4())}, {_literal(USER_A)})",
            "UPDATE public.recipe_feed_items SET position=100",
            "INSERT INTO public.recipe_feed_items "
            "(id,user_id,session_id,position,recipe) "
            f"VALUES ({_literal(uuid4())}, {_literal(USER_A)}, "
            f"{_literal(session_id)}, 100, '{{}}')",
            "DELETE FROM public.recipe_feed_sessions",
            "SELECT * FROM public.claim_recipe_feed_refill("
            f"{_literal(USER_A)}, {_literal(session_id)}, 1, {_literal(uuid4())})",
            "SELECT * FROM public.finalize_recipe_feed_refill("
            f"{_literal(USER_A)}, {_literal(session_id)}, {_literal(uuid4())}, "
            "'[]', '{}', 0)",
            "SELECT * FROM public.release_recipe_feed_refill("
            f"{_literal(USER_A)}, {_literal(session_id)}, {_literal(uuid4())})",
            "SELECT * FROM public.create_recipe_feed_session("
            f"{_literal(USER_A)}, '{{}}', '[]')",
        ):
            result = database.run(sql, role=role, user=USER_A, check=False)
            assert result.returncode != 0
            assert "permission denied" in result.stderr
    assert database.session(session_id)["generation_runs"] == 1


def test_real_rls_hides_another_users_session_and_items(database):
    session_id = database.create()
    for user, count in ((USER_A, "1"), (USER_B, "0")):
        for table, column in (
            ("recipe_feed_sessions", "id"),
            ("recipe_feed_items", "session_id"),
        ):
            assert (
                database.run(
                    f"SELECT count(*) FROM public.{table} "
                    f"WHERE {column}={_literal(session_id)}",
                    role="authenticated",
                    user=user,
                )
                == count
            )
    assert database.claim(session_id, 1, user=USER_B) is None
    database.run(
        "UPDATE public.recipe_feed_sessions "
        "SET expires_at = now() - interval '1 second' "
        f"WHERE id={_literal(session_id)}"
    )
    assert database.claim(session_id, 1) is None


def test_simultaneous_claims_reserve_only_one_run_and_preserve_cards(database):
    session_id = database.create()
    database.run(
        "UPDATE public.recipe_feed_sessions SET generation_runs=5 "
        f"WHERE id={_literal(session_id)}"
    )
    with ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(lambda _: database.claim(session_id, 5), range(4)))
    assert {row["generation_runs"] for row in results} == {6}
    assert len({row["refill_claim_id"] for row in results}) == 1
    original = database.run(
        "SELECT recipe FROM public.recipe_feed_items "
        f"WHERE session_id={_literal(session_id)} AND position=0"
    )
    claim_id = results[0]["refill_claim_id"]
    recipe = _recipe("Next")
    finalized = json.loads(database.finalize(session_id, claim_id, [recipe]))
    assert finalized["candidate_count"] == 2
    assert finalized["generation_runs"] == 6
    assert finalized["retrieval_cursor"] == 10
    assert finalized["exclude_titles"] == ["Initial", "Next"]
    assert finalized["has_more"] is False
    assert (
        database.run(
            "SELECT recipe FROM public.recipe_feed_items "
            f"WHERE session_id={_literal(session_id)} AND position=0"
        )
        == original
    )
    # Retrying a committed finalization cannot insert a second copy.
    assert json.loads(database.finalize(session_id, claim_id, [recipe])) == finalized
    assert database.claim(session_id, 6)["refill_claim_id"] is None


def test_failed_finalization_rolls_back_candidates_and_metadata(database):
    session_id = database.create()
    claim = database.claim(session_id, 1)
    duplicate = _recipe("Duplicate id")
    failed = database.finalize(
        session_id,
        claim["refill_claim_id"],
        [duplicate, duplicate],
        check=False,
    )
    assert failed.returncode != 0
    assert "duplicate key" in failed.stderr
    assert database.session(session_id) == claim
    assert (
        database.run(
            "SELECT count(*) FROM public.recipe_feed_items "
            f"WHERE session_id={_literal(session_id)}"
        )
        == "1"
    )
    succeeded = json.loads(
        database.finalize(session_id, claim["refill_claim_id"], [duplicate])
    )
    assert succeeded["candidate_count"] == 2


def test_crashed_claims_expire_without_resetting_attempt_budget(database):
    session_id = database.create()
    for run in range(2, 7):
        claim = database.claim(session_id, run - 1)
        assert claim["generation_runs"] == run
        database.run(
            "UPDATE public.recipe_feed_sessions "
            "SET refill_claim_expires_at = now() - interval '1 second' "
            f"WHERE id = {_literal(session_id)}"
        )
        stale = database.finalize(
            session_id, claim["refill_claim_id"], [_recipe("Late")], check=False
        )
        assert stale.returncode != 0
        assert "claim is stale" in stale.stderr
    exhausted = database.claim(session_id, 6)
    assert exhausted["generation_runs"] == 6
    assert exhausted["has_more"] is False
    assert exhausted["refill_claim_id"] is None
    assert exhausted["candidate_count"] == 1


def test_initial_candidates_and_session_are_one_transaction(database):
    duplicate = _recipe("Duplicate")
    before = database.run("SELECT count(*) FROM public.recipe_feed_sessions")
    with pytest.raises(AssertionError, match="duplicate key"):
        database.create(recipes=[duplicate, duplicate])
    assert database.run("SELECT count(*) FROM public.recipe_feed_sessions") == before


def test_exhaustion_is_persisted_without_spending_another_run(database):
    session_id = database.create()
    database.run(
        "UPDATE public.recipe_feed_sessions SET usable_items='[]' "
        f"WHERE id={_literal(session_id)}"
    )
    exhausted = database.claim(session_id, 1)
    assert exhausted["has_more"] is False
    assert exhausted["generation_runs"] == 1
    assert database.session(session_id) == exhausted


def test_failed_claim_release_preserves_budget_and_cannot_clear_another_owner(database):
    session_id = database.create()
    first = database.claim(session_id, 1)
    database.run(
        "SELECT * FROM public.release_recipe_feed_refill("
        f"{_literal(USER_A)}, {_literal(session_id)}, "
        f"{_literal(first['refill_claim_id'])})",
        role="service_role",
    )
    assert database.session(session_id)["generation_runs"] == 2
    next_claim = database.claim(session_id, 2)
    database.run(
        "SELECT * FROM public.release_recipe_feed_refill("
        f"{_literal(USER_A)}, {_literal(session_id)}, "
        f"{_literal(first['refill_claim_id'])})",
        role="service_role",
    )
    assert database.session(session_id) == next_claim
    assert next_claim["generation_runs"] == 3


def test_stale_snapshot_cannot_claim_after_another_request_commits(database):
    session_id = database.create()
    claim = database.claim(session_id, 1)
    finalized = json.loads(
        database.finalize(
            session_id,
            claim["refill_claim_id"],
            [_recipe("Next")],
        )
    )
    stale = database.claim(session_id, 1)
    assert stale == finalized
    assert stale["refill_claim_id"] is None
    assert stale["generation_runs"] == 2
