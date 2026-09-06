"""Cook RPC contract tests against a disposable local PostgreSQL cluster."""

# SQL fixture strings are intentionally kept readable at their database shape.
# ruff: noqa: E501

from __future__ import annotations

import json
import os
import subprocess
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit
from uuid import uuid4

import httpx
import pytest
from fastapi.testclient import TestClient
from jose import jwt

from app.core.config import settings
from app.main import create_app
from tests.conftest import SigningKey

DSN = os.environ.get("FRESHPLATE_TEST_POSTGRES_DSN", "")
pytestmark = pytest.mark.skipif(not DSN, reason="Requires disposable local PostgreSQL")
MIGRATION = (
    Path(__file__).parents[2]
    / "supabase/migrations/20260905071100_add_cook_deduction_rpc.sql"
)
USER = "00000000-0000-0000-0000-000000000001"
OTHER = "00000000-0000-0000-0000-000000000002"


def q(value: object) -> str:
    return "'" + str(value).replace("'", "''") + "'"


def j(value: object) -> str:
    return q(json.dumps(value)) + "::jsonb"


class DB:
    def __init__(self, dsn: str):
        self.dsn = dsn

    def run(
        self, sql: str, *, role: str | None = None, user: str | None = None, check=True
    ):
        prefix = f"SET ROLE {role};" if role else ""
        if user:
            prefix += f"SET request.jwt.claim.sub = {q(user)};"
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


@pytest.fixture(scope="module")
def database():
    parsed = urlsplit(DSN)
    assert parsed.hostname in {"localhost", "127.0.0.1", "::1"}
    admin = DB(DSN)
    name = "freshplate_cook_test_" + uuid4().hex
    admin.run("""
        DO $$ BEGIN
          IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF;
          IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
        END $$;
    """)
    admin.run(f"CREATE DATABASE {name}")
    db = DB(urlunsplit(parsed._replace(path="/" + name)))
    try:
        db.run(f"""
          CREATE EXTENSION pgcrypto;
          CREATE SCHEMA auth;
          CREATE TABLE auth.users(id uuid primary key);
          CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
          CREATE TABLE households(id uuid primary key);
          CREATE TABLE household_members(household_id uuid, user_id uuid);
          CREATE TABLE inventory_items(
            id uuid primary key, household_id uuid not null, name text not null,
            quantity numeric(7,2) not null
          );
          GRANT USAGE ON SCHEMA auth TO authenticated;
          GRANT EXECUTE ON FUNCTION auth.uid() TO authenticated;
          GRANT SELECT ON public.household_members TO authenticated;
          INSERT INTO auth.users VALUES ({q(USER)}), ({q(OTHER)});
        """)
        db.run(MIGRATION.read_text())
        db.run("""
          ALTER TABLE public.inventory_items ENABLE ROW LEVEL SECURITY;
          CREATE POLICY inventory_select ON public.inventory_items FOR SELECT TO authenticated
            USING (EXISTS (SELECT 1 FROM public.household_members hm
              WHERE hm.household_id = inventory_items.household_id AND hm.user_id = auth.uid()));
          CREATE POLICY inventory_update ON public.inventory_items FOR UPDATE TO authenticated
            USING (EXISTS (SELECT 1 FROM public.household_members hm
              WHERE hm.household_id = inventory_items.household_id AND hm.user_id = auth.uid()));
          ALTER TABLE public.household_members ENABLE ROW LEVEL SECURITY;
          CREATE POLICY membership_select ON public.household_members FOR SELECT TO authenticated
            USING (user_id = auth.uid());
          GRANT SELECT, UPDATE ON public.inventory_items TO authenticated;
          GRANT SELECT ON public.household_members TO authenticated;
          GRANT SELECT, INSERT ON public.cook_events TO authenticated;
          GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO authenticated;
        """)
        yield db
    finally:
        admin.run(f"DROP DATABASE {name} WITH (FORCE)")


def seed(db: DB, quantity=3):
    household, item, recipe, operation = [str(uuid4()) for _ in range(4)]
    db.run(
        f"INSERT INTO households VALUES ({q(household)}); INSERT INTO household_members VALUES ({q(household)}, {q(USER)}); INSERT INTO inventory_items(id, household_id, name, quantity) VALUES ({q(item)}, {q(household)}, 'Beans', {quantity});"
    )
    return household, item, recipe, operation


def call(
    db,
    household,
    operation,
    recipe,
    deductions,
    snapshot=None,
    *,
    user=USER,
    role="authenticated",
    check=True,
):
    snapshot = snapshot or {"recipe_id": recipe, "title": "Beans"}
    return db.run(
        f"SELECT public.cook_recipe({q(household)}, {q(operation)}, {q(recipe)}, {j(snapshot)}, {j(deductions)})",
        role=role,
        user=user,
        check=check,
    )


def test_deduction_commits_event_and_soft_deletes_zero_quantity(database):
    household, item, recipe, operation = seed(database, 2)
    result = json.loads(
        call(
            database,
            household,
            operation,
            recipe,
            [{"inventory_item_id": item, "confirmed_amount": 2}],
        )
    )
    assert result["deductions"][0] == {
        "inventory_item_id": item,
        "confirmed_amount": 2,
        "committed_amount": 2,
    }
    assert (
        database.run(f"SELECT quantity::text FROM inventory_items WHERE id={q(item)}")
        == "0"
    )
    assert (
        database.run(
            f"SELECT depleted_at IS NOT NULL FROM inventory_items WHERE id={q(item)}"
        )
        == "t"
    )


def test_replay_returns_original_result_and_changed_payload_fails(database):
    household, item, recipe, operation = seed(database)
    first = call(
        database,
        household,
        operation,
        recipe,
        [{"inventory_item_id": item, "confirmed_amount": 2}],
    )
    assert (
        call(
            database,
            household,
            operation,
            recipe,
            [{"inventory_item_id": item, "confirmed_amount": 2}],
        )
        == first
    )
    failed = call(
        database,
        household,
        operation,
        recipe,
        [{"inventory_item_id": item, "confirmed_amount": 1}],
        check=False,
    )
    assert failed.returncode != 0
    assert (
        database.run(f"SELECT quantity::text FROM inventory_items WHERE id={q(item)}")
        == "1"
    )


def test_replay_survives_inventory_delete(database):
    household, item, recipe, operation = seed(database)
    first = call(
        database,
        household,
        operation,
        recipe,
        [{"inventory_item_id": item, "confirmed_amount": 1}],
    )
    database.run(f"DELETE FROM inventory_items WHERE id={q(item)}")
    assert (
        call(
            database,
            household,
            operation,
            recipe,
            [{"inventory_item_id": item, "confirmed_amount": 1}],
        )
        == first
    )


def test_exact_decimal_usage_reports_actual_committed_delta(database):
    household, item, recipe, operation = seed(database, 1)
    result = json.loads(
        call(
            database,
            household,
            operation,
            recipe,
            [{"inventory_item_id": item, "confirmed_amount": ".999"}],
        )
    )
    assert result["deductions"][0]["confirmed_amount"] == 0.999
    assert result["deductions"][0]["committed_amount"] == 0.999
    assert (
        database.run(
            f"SELECT quantity::text, depleted_at IS NULL FROM inventory_items WHERE id={q(item)}"
        )
        == "0.001|t"
    )


def test_stale_depletion_records_zero_committed(database):
    household, item, recipe, operation = seed(database, 2)
    database.run(
        f"UPDATE inventory_items SET quantity=0, depleted_at=now() WHERE id={q(item)}"
    )
    result = json.loads(
        call(
            database,
            household,
            operation,
            recipe,
            [{"inventory_item_id": item, "confirmed_amount": 2}],
        )
    )
    assert result["deductions"][0] == {
        "inventory_item_id": item,
        "confirmed_amount": 2,
        "committed_amount": 0,
    }


@pytest.mark.parametrize(
    "amount",
    [
        0,
        -1,
        "NaN",
        "+Infinity",
        "-Infinity",
        None,
    ],
)
def test_invalid_amount_rolls_back(database, amount):
    household, item, recipe, operation = seed(database)
    event_count = database.run("SELECT count(*) FROM cook_events")
    failed = call(
        database,
        household,
        operation,
        recipe,
        [{"inventory_item_id": item, "confirmed_amount": amount}],
        check=False,
    )
    assert failed.returncode != 0
    assert (
        database.run(f"SELECT quantity::text FROM inventory_items WHERE id={q(item)}")
        == "3"
    )
    assert database.run("SELECT count(*) FROM cook_events") == event_count


def test_foreign_household_and_snapshot_mismatch_are_rejected(database):
    household, item, recipe, operation = seed(database)
    foreign_household, foreign_item, _, _ = seed(database)
    database.run(
        f"UPDATE household_members SET user_id={q(OTHER)} WHERE household_id={q(foreign_household)}"
    )
    failed = call(
        database,
        household,
        operation,
        recipe,
        [{"inventory_item_id": foreign_item, "confirmed_amount": 1}],
        check=False,
    )
    assert failed.returncode != 0
    assert database.run(f"SELECT quantity::text FROM inventory_items WHERE id={q(item)}") == "3"


def test_replay_with_snapshot_recipe_id_mismatch_is_rejected(database):
    household, item, recipe, operation = seed(database)
    call(
        database,
        household,
        operation,
        recipe,
        [{"inventory_item_id": item, "confirmed_amount": 1}],
    )
    failed = call(
        database,
        household,
        operation,
        recipe,
        [{"inventory_item_id": item, "confirmed_amount": 1}],
        snapshot={"recipe_id": str(uuid4()), "title": "Beans"},
        check=False,
    )
    assert failed.returncode != 0
    assert database.run(f"SELECT quantity::text FROM inventory_items WHERE id={q(item)}") == "2"
    assert database.run(f"SELECT count(*) FROM cook_events WHERE operation_id={q(operation)}") == "1"


def test_duplicate_inventory_id_is_rejected_without_side_effects(database):
    household, item, recipe, operation = seed(database)
    event_count = database.run("SELECT count(*) FROM cook_events")
    failed = call(
        database,
        household,
        operation,
        recipe,
        [
            {"inventory_item_id": item, "confirmed_amount": 1},
            {"inventory_item_id": item, "confirmed_amount": 1},
        ],
        check=False,
    )
    assert failed.returncode != 0
    assert database.run(f"SELECT quantity::text FROM inventory_items WHERE id={q(item)}") == "3"
    assert database.run("SELECT count(*) FROM cook_events") == event_count


def test_anonymous_role_cannot_call_cook_rpc(database):
    household, item, recipe, operation = seed(database)
    failed = call(
        database,
        household,
        operation,
        recipe,
        [{"inventory_item_id": item, "confirmed_amount": 1}],
        user=None,
        role="anon",
        check=False,
    )
    assert failed.returncode != 0
    assert database.run(f"SELECT quantity::text FROM inventory_items WHERE id={q(item)}") == "3"


def test_mixed_valid_and_foreign_rows_roll_back(database):
    household, item, recipe, operation = seed(database)
    foreign_household, foreign_item, _, _ = seed(database)
    database.run(
        f"UPDATE household_members SET user_id={q(OTHER)} WHERE household_id={q(foreign_household)}"
    )
    failed = call(
        database,
        household,
        operation,
        recipe,
        [
            {"inventory_item_id": item, "confirmed_amount": 1},
            {"inventory_item_id": foreign_item, "confirmed_amount": 1},
        ],
        check=False,
    )
    assert failed.returncode != 0
    assert database.run(f"SELECT quantity::text FROM inventory_items WHERE id={q(item)}") == "3"
    assert database.run(f"SELECT count(*) FROM cook_events WHERE operation_id={q(operation)}") == "0"


class RpcHttpClient:
    def __init__(self, database): self.database = database
    async def post(self, url, *, headers, json, timeout):
        user = jwt.get_unverified_claims(headers["Authorization"][7:])["sub"]
        result = call(self.database, json["p_household_id"], json["p_operation_id"], json["p_recipe_id"], json["p_deductions"], snapshot=json["p_recipe_snapshot"], user=user, check=False)
        if result.returncode:
            return httpx.Response(409, request=httpx.Request("POST", url))
        return httpx.Response(200, request=httpx.Request("POST", url), content=__import__("json").dumps(json_module(result.stdout)).encode())


def json_module(value):
    return json.loads(value)


def test_http_forwards_jwt_to_real_rpc(database, patch_jwks):
    key = SigningKey("cook-http")
    patch_jwks([key])
    settings.supabase_url = "https://supabase.test"
    settings.supabase_publishable_key = "key"
    household, item, recipe, operation = seed(database, 2)
    app = create_app()
    with TestClient(app) as client:
        client.app.state.supabase_http_client = RpcHttpClient(database)
        response = client.post("/api/cook/confirm", headers={"Authorization": f"Bearer {key.sign(sub=USER)}"}, json={"household_id": household, "operation_id": operation, "recipe_id": recipe, "recipe_snapshot": {"recipe_id": recipe, "title": "Beans"}, "deductions": [{"inventory_item_id": item, "confirmed_amount": 2}]})
    assert response.status_code == 200
    assert database.run(f"SELECT quantity::text FROM inventory_items WHERE id={q(item)}") == "0.0"


def _http_body(household, item, recipe, operation, amount=1, title="Beans"):
    return {
        "household_id": household,
        "operation_id": operation,
        "recipe_id": recipe,
        "recipe_snapshot": {"recipe_id": recipe, "title": title},
        "deductions": [{"inventory_item_id": item, "confirmed_amount": amount}],
    }


def test_http_two_users_forward_distinct_auth_uid_and_reject_foreign_household(
    database, patch_jwks
):
    key = SigningKey("cook-users")
    patch_jwks([key])
    other = OTHER
    household_a, item_a, recipe_a, operation_a = seed(database, 2)
    household_b, item_b, recipe_b, operation_b = seed(database, 2)
    database.run(
        f"UPDATE household_members SET user_id={q(other)} WHERE household_id={q(household_b)}"
    )
    app = create_app()
    with TestClient(app) as client:
        client.app.state.supabase_http_client = RpcHttpClient(database)
        headers_a = {"Authorization": f"Bearer {key.sign(sub=USER)}"}
        headers_b = {"Authorization": f"Bearer {key.sign(sub=other)}"}
        with ThreadPoolExecutor(max_workers=2) as pool:
            responses = list(
                pool.map(
                    lambda args: client.post(
                        "/api/cook/confirm", headers=args[0], json=args[1]
                    ),
                    [
                        (headers_a, _http_body(household_a, item_a, recipe_a, operation_a)),
                        (headers_b, _http_body(household_b, item_b, recipe_b, operation_b)),
                    ],
                )
            )
        assert [response.status_code for response in responses] == [200, 200]
        foreign = client.post(
            "/api/cook/confirm",
            headers=headers_a,
            json=_http_body(household_b, item_b, str(uuid4()), str(uuid4())),
        )
        assert foreign.status_code == 409
    assert database.run(f"SELECT quantity::text FROM inventory_items WHERE id={q(item_a)}") == "1.0"
    assert database.run(f"SELECT quantity::text FROM inventory_items WHERE id={q(item_b)}") == "1.0"
    assert database.run(f"SELECT user_id FROM cook_events WHERE operation_id={q(operation_a)}") == USER
    assert database.run(f"SELECT user_id FROM cook_events WHERE operation_id={q(operation_b)}") == OTHER
    assert database.run(f"SELECT count(*) FROM cook_events WHERE household_id={q(household_b)} AND user_id={q(USER)}") == "0"


def test_http_replay_after_delete_and_parallel_replay_deduct_once(database, patch_jwks):
    key = SigningKey("cook-replay")
    patch_jwks([key])
    household, item, recipe, operation = seed(database, 2)
    app = create_app()
    body = _http_body(household, item, recipe, operation, title="Same title")
    headers = {"Authorization": f"Bearer {key.sign(sub=USER)}"}
    with TestClient(app) as client:
        client.app.state.supabase_http_client = RpcHttpClient(database)
        first = client.post("/api/cook/confirm", headers=headers, json=body)
        assert first.status_code == 200
        database.run(f"DELETE FROM inventory_items WHERE id={q(item)}")
        with ThreadPoolExecutor(max_workers=2) as pool:
            responses = list(pool.map(lambda _: client.post("/api/cook/confirm", headers=headers, json=body), range(2)))
    assert all(response.status_code == 200 for response in responses)
    assert database.run(f"SELECT count(*) FROM cook_events WHERE operation_id={q(operation)}") == "1"


def test_http_parallel_initial_same_operation_deducts_once(database, patch_jwks):
    key = SigningKey("cook-http-concurrent")
    patch_jwks([key])
    household, item, recipe, operation = seed(database, 3)
    app = create_app()
    headers = {"Authorization": f"Bearer {key.sign(sub=USER)}"}
    body = _http_body(household, item, recipe, operation, amount=2)
    with TestClient(app) as client:
        client.app.state.supabase_http_client = RpcHttpClient(database)
        with ThreadPoolExecutor(max_workers=2) as pool:
            responses = list(pool.map(lambda _: client.post("/api/cook/confirm", headers=headers, json=body), range(2)))
    assert all(response.status_code == 200 for response in responses)
    assert database.run(f"SELECT quantity::text FROM inventory_items WHERE id={q(item)}") == "1.0"
    assert database.run(f"SELECT count(*) FROM cook_events WHERE operation_id={q(operation)}") == "1"


def test_http_same_title_recipes_keep_distinct_uuid_identity(database, patch_jwks):
    key = SigningKey("cook-identity")
    patch_jwks([key])
    household, item_a, recipe_a, operation_a = seed(database, 2)
    item_b, recipe_b, operation_b = str(uuid4()), str(uuid4()), str(uuid4())
    database.run(
        f"INSERT INTO inventory_items(id, household_id, name, quantity) VALUES ({q(item_b)}, {q(household)}, 'Beans', 2)"
    )
    app = create_app()
    headers = {"Authorization": f"Bearer {key.sign(sub=USER)}"}
    with TestClient(app) as client:
        client.app.state.supabase_http_client = RpcHttpClient(database)
        for item, recipe, operation in ((item_a, recipe_a, operation_a), (item_b, recipe_b, operation_b)):
            response = client.post("/api/cook/confirm", headers=headers, json=_http_body(household, item, recipe, operation, title="Same title"))
            assert response.status_code == 200
    assert database.run(
        f"SELECT count(*) FROM cook_events WHERE household_id={q(household)} AND recipe_snapshot->>'title'='Same title'"
    ) == "2"
    assert database.run(
        "SELECT string_agg(recipe_id::text, ',' ORDER BY recipe_id) FROM cook_events "
        f"WHERE household_id={q(household)} AND recipe_snapshot->>'title'='Same title'"
    ) == ",".join(sorted((recipe_a, recipe_b)))


def concurrent_calls(db, calls):
    barrier = __import__("threading").Barrier(len(calls))

    def run_call(args):
        barrier.wait(timeout=5)
        return call(db, *args)

    with ThreadPoolExecutor(max_workers=len(calls)) as pool:
        futures = [pool.submit(run_call, args) for args in calls]
        return [future.result(timeout=10) for future in futures]


def test_concurrent_same_operation_is_idempotent(database):
    household, item, recipe, operation = seed(database, 3)
    args = (household, operation, recipe,
            [{"inventory_item_id": item, "confirmed_amount": 2}])
    results = concurrent_calls(database, [args, args])
    assert results[0] == results[1]
    assert database.run(f"SELECT quantity::text FROM inventory_items WHERE id={q(item)}") == "1"
    assert database.run(
        f"SELECT count(*) FROM cook_events WHERE operation_id={q(operation)}"
    ) == "1"


def test_concurrent_reversed_rows_complete_without_deadlock(database):
    household, first, recipe, _ = seed(database, 3)
    second = str(uuid4())
    database.run(
        f"INSERT INTO inventory_items VALUES ({q(second)}, {q(household)}, 'Rice', 3)"
    )
    calls = [
        (household, str(uuid4()), recipe, [
            {"inventory_item_id": first, "confirmed_amount": 1},
            {"inventory_item_id": second, "confirmed_amount": 1},
        ]),
        (household, str(uuid4()), recipe, [
            {"inventory_item_id": second, "confirmed_amount": 1},
            {"inventory_item_id": first, "confirmed_amount": 1},
        ]),
    ]
    results = concurrent_calls(database, calls)
    assert all(len(json.loads(result)["deductions"]) == 2 for result in results)
    assert database.run(
        f"SELECT quantity::text FROM inventory_items WHERE id IN ({q(first)}, {q(second)}) ORDER BY id"
    ).splitlines() == ["1", "1"]


def test_concurrent_stale_depletion_preserves_both_confirmed_amounts(database):
    household, item, recipe, _ = seed(database, 2)
    calls = [
        (household, str(uuid4()), recipe, [{"inventory_item_id": item, "confirmed_amount": 2}]),
        (household, str(uuid4()), recipe, [{"inventory_item_id": item, "confirmed_amount": 2}]),
    ]
    results = [json.loads(result) for result in concurrent_calls(database, calls)]
    deductions = [result["deductions"][0] for result in results]
    assert sorted(line["committed_amount"] for line in deductions) == [0, 2]
    assert all(line["confirmed_amount"] == 2 for line in deductions)
    assert database.run(f"SELECT quantity::text FROM inventory_items WHERE id={q(item)}") == "0"


def test_delete_race_rejects_whole_request_before_any_deduction(database):
    household, item, recipe, operation = seed(database, 2)
    other = str(uuid4())
    database.run(
        f"INSERT INTO inventory_items VALUES ({q(other)}, {q(household)}, 'Rice', 3)"
    )
    holder = subprocess.Popen(
        ["psql", "-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-d", database.dsn],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
    )
    holder.stdin.write(
        f"BEGIN; DELETE FROM inventory_items WHERE id={q(item)}; SELECT 'deleted'; SELECT pg_sleep(2); COMMIT;\n"
    )
    holder.stdin.flush()
    assert holder.stdout.readline().strip() == "deleted"
    failed = call(database, household, operation, recipe, [
        {"inventory_item_id": item, "confirmed_amount": 1},
        {"inventory_item_id": other, "confirmed_amount": 1},
    ], check=False)
    holder.stdin.close()
    holder.wait(timeout=5)
    assert failed.returncode != 0
    assert database.run(f"SELECT quantity::text FROM inventory_items WHERE id={q(other)}") == "3"
    assert database.run(f"SELECT count(*) FROM cook_events WHERE operation_id={q(operation)}") == "0"
