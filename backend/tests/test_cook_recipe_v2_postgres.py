"""cook_recipe_v2 contract tests against a disposable local PostgreSQL cluster."""

# ruff: noqa: E501

from __future__ import annotations

import asyncio
import json
from concurrent.futures import ThreadPoolExecutor
from datetime import date, timedelta
from threading import Barrier
from uuid import uuid4

import httpx
import pytest
from fastapi.testclient import TestClient
from jose import jwt

from app.core.config import settings
from app.main import create_app
from tests.conftest import SigningKey
from tests.pg_support import (
    DB,
    DSN,
    FOODS_MIGRATIONS,
    OTHER,
    USER,
    add_lot,
    add_lot_sql,
    disposable_database,
    household,
    q,
    while_holding,
)

pytestmark = pytest.mark.skipif(not DSN, reason="Requires disposable local PostgreSQL")

MIGRATIONS = (*FOODS_MIGRATIONS, "20261113120000_add_cook_recipe_v2.sql")


@pytest.fixture(scope="module")
def database():
    yield from disposable_database(MIGRATIONS)


@pytest.fixture(scope="module")
def today(database) -> date:
    return date.fromisoformat(database.run("SELECT current_date"))


def j(value: object) -> str:
    return q(json.dumps(value)) + "::jsonb"


def cook_sql(home, deductions, *, operation=None, recipe=None, snapshot=None) -> str:
    operation = operation or str(uuid4())
    recipe = recipe or str(uuid4())
    snapshot = snapshot or {"recipe_id": recipe, "title": "Stew"}
    return f"SELECT public.cook_recipe_v2({q(home)}, {q(operation)}, {q(recipe)}, {j(snapshot)}, {j(deductions)});"


def cook(db: DB, home, deductions, *, user=USER, role="authenticated", check=True, **kwargs):
    sql = cook_sql(home, deductions, **kwargs)
    if check:
        return db.json(sql, role=role, user=user)
    return db.run(sql, role=role, user=user, check=False)


def lot(db: DB, home, name, stock_base, quantity, location="fridge", **kwargs) -> tuple[str, str]:
    """Add a lot and return (food_id, lot_id)."""
    result = add_lot(db, home, name, stock_base, quantity, location, **kwargs)
    return result["food_id"], result["lot_id"]


def lot_state(db: DB, lot_id):
    return db.json(
        f"SELECT json_build_object('quantity', quantity, 'opened', opened_at IS NOT NULL, 'reason', depleted_reason) FROM lots WHERE id = {q(lot_id)}"
    )


def test_draw_takes_opened_then_soonest_expiry_then_oldest_and_finishes_each_lot(database, today):
    home = household(database)
    food, undated = lot(database, home, "Milk", "ml", 1000)
    _, later = lot(database, home, "Milk", "ml", 1000, expiration_date=today + timedelta(days=9))
    _, sooner = lot(database, home, "Milk", "ml", 1000, expiration_date=today + timedelta(days=3))
    _, opened = lot(database, home, "Milk", "ml", 200, expiration_date=today + timedelta(days=20))
    database.run(f"UPDATE lots SET opened_at = now() WHERE id = {q(opened)}")

    result = cook(database, home, [{"inventory_item_id": food, "confirmed_amount": 1500}])

    [line] = result["deductions"]
    assert line["draws"] == [
        {"lot_id": opened, "amount": 200},
        {"lot_id": sooner, "amount": 1000},
        {"lot_id": later, "amount": 300},
    ]
    assert (line["food_id"], line["confirmed_amount"], line["committed_amount"]) == (food, 1500, 1500)
    assert lot_state(database, opened) == {"quantity": 0, "opened": True, "reason": "used"}
    assert lot_state(database, sooner) == {"quantity": 0, "opened": True, "reason": "used"}
    assert lot_state(database, later) == {"quantity": 700, "opened": True, "reason": None}
    assert lot_state(database, undated) == {"quantity": 1000, "opened": False, "reason": None}


def test_equal_lots_are_drawn_oldest_first(database):
    home = household(database)
    food, first = lot(database, home, "Rice", "g", 500, "pantry")
    _, second = lot(database, home, "Rice", "g", 500, "pantry", notes="second bag")

    result = cook(database, home, [{"inventory_item_id": food, "confirmed_amount": 600}])

    assert result["deductions"][0]["draws"] == [
        {"lot_id": first, "amount": 500},
        {"lot_id": second, "amount": 100},
    ]


def test_expired_lots_are_skipped_and_the_rest_is_a_shortfall(database, today):
    home = household(database)
    food, expired = lot(database, home, "Yogurt", "g", 500, expiration_date=today - timedelta(days=1))
    _, fresh = lot(database, home, "Yogurt", "g", 200, expiration_date=today)

    result = cook(database, home, [{"inventory_item_id": food, "confirmed_amount": 300}])

    [line] = result["deductions"]
    assert line["draws"] == [{"lot_id": fresh, "amount": 200}]
    assert (line["confirmed_amount"], line["committed_amount"]) == (300, 200)
    assert lot_state(database, expired) == {"quantity": 500, "opened": False, "reason": None}
    assert lot_state(database, fresh) == {"quantity": 0, "opened": True, "reason": "used"}


def test_a_food_with_no_stock_records_the_whole_amount_as_shortfall(database):
    home = household(database)
    food, used = lot(database, home, "Basil", "g", 20)
    cook(database, home, [{"inventory_item_id": food, "confirmed_amount": 20}])

    result = cook(database, home, [{"inventory_item_id": food, "confirmed_amount": 5}])

    assert result["deductions"][0] == {
        "inventory_item_id": food, "food_id": food, "confirmed_amount": 5, "committed_amount": 0, "draws": [],
    }
    assert lot_state(database, used)["quantity"] == 0


@pytest.mark.parametrize("amount", [0, -1, "NaN", "Infinity", "-Infinity", None])
def test_invalid_amount_rolls_back_every_line(database, amount):
    home = household(database)
    milk, milk_lot = lot(database, home, "Milk", "ml", 1000)
    rice, _ = lot(database, home, "Rice", "g", 500, "pantry")
    events = database.run("SELECT count(*) FROM cook_events")

    failed = cook(database, home, [
        {"inventory_item_id": milk, "confirmed_amount": 100},
        {"inventory_item_id": rice, "confirmed_amount": amount},
    ], check=False)

    assert failed.returncode != 0 and "finite and positive" in failed.stderr
    assert lot_state(database, milk_lot)["quantity"] == 1000
    assert database.run("SELECT count(*) FROM cook_events") == events


def test_fractional_amount_on_a_whole_units_food_is_rejected(database):
    home = household(database)
    food, can = lot(database, home, "Beans", "each", 3, "pantry", each_label="can", whole_units_only=True)

    failed = cook(database, home, [{"inventory_item_id": food, "confirmed_amount": 1.5}], check=False)
    whole = cook(database, home, [{"inventory_item_id": food, "confirmed_amount": 2}])

    assert failed.returncode != 0 and "whole units only" in failed.stderr
    assert whole["deductions"][0]["committed_amount"] == 2
    assert lot_state(database, can)["quantity"] == 1


def test_a_lot_id_from_an_older_saved_recipe_draws_from_its_food(database, today):
    home = household(database)
    food, older = lot(database, home, "Eggs", "each", 6, each_label="egg", expiration_date=today + timedelta(days=9))
    _, sooner = lot(database, home, "Eggs", "each", 2, each_label="egg", expiration_date=today + timedelta(days=2))

    result = cook(database, home, [{"inventory_item_id": older, "confirmed_amount": 3}])

    [line] = result["deductions"]
    assert (line["inventory_item_id"], line["food_id"]) == (older, food)
    assert line["draws"] == [{"lot_id": sooner, "amount": 2}, {"lot_id": older, "amount": 1}]


def test_a_merged_food_draws_from_the_food_it_was_merged_into(database):
    home = household(database)
    target, target_lot = lot(database, home, "Basmati rice", "g", 1000, "pantry")
    old = database.run(
        f"INSERT INTO foods(household_id, name, stock_base, archived_at, merged_into_id) VALUES ({q(home)}, 'Rice', 'g', now(), {q(target)}) RETURNING id"
    ).splitlines()[0]

    result = cook(database, home, [{"inventory_item_id": old, "confirmed_amount": 250}])

    assert result["deductions"][0]["food_id"] == target
    assert lot_state(database, target_lot)["quantity"] == 750


def test_duplicate_foods_and_foreign_or_unknown_ids_change_nothing(database):
    home = household(database)
    food, own = lot(database, home, "Oats", "g", 500, "pantry")
    foreign_home = household(database, member=OTHER)
    foreign_food, foreign_lot = lot(database, foreign_home, "Oats", "g", 500, "pantry", user=OTHER)

    attempts = [
        ([{"inventory_item_id": food, "confirmed_amount": 1}, {"inventory_item_id": food, "confirmed_amount": 1}], "DUPLICATE_FOOD"),
        ([{"inventory_item_id": food, "confirmed_amount": 1}, {"inventory_item_id": own, "confirmed_amount": 1}], "DUPLICATE_FOOD"),
        ([{"inventory_item_id": food, "confirmed_amount": 1}, {"inventory_item_id": foreign_food, "confirmed_amount": 1}], "FOOD_NOT_FOUND"),
        ([{"inventory_item_id": food, "confirmed_amount": 1}, {"inventory_item_id": foreign_lot, "confirmed_amount": 1}], "FOOD_NOT_FOUND"),
        ([{"inventory_item_id": str(uuid4()), "confirmed_amount": 1}], "FOOD_NOT_FOUND"),
    ]
    for deductions, error in attempts:
        assert error in cook(database, home, deductions, check=False).stderr
    assert lot_state(database, own)["quantity"] == 500
    assert lot_state(database, foreign_lot)["quantity"] == 500
    assert database.run(f"SELECT count(*) FROM cook_events WHERE household_id = {q(home)}") == "0"


def test_non_members_anon_and_signed_out_callers_cannot_cook(database):
    home = household(database)
    food, own = lot(database, home, "Flour", "g", 1000, "pantry")
    deductions = [{"inventory_item_id": food, "confirmed_amount": 100}]

    outsider = cook(database, home, deductions, user=OTHER, check=False)
    anon = cook(database, home, deductions, role="anon", user=None, check=False)
    signed_out = cook(database, home, deductions, user=None, check=False)

    assert "Household membership required" in outsider.stderr
    assert "permission denied" in anon.stderr
    assert "Authentication required" in signed_out.stderr
    assert lot_state(database, own)["quantity"] == 1000


def test_replay_returns_the_first_result_and_a_changed_payload_fails(database):
    home = household(database)
    food, own = lot(database, home, "Butter", "g", 250)
    operation, recipe = str(uuid4()), str(uuid4())
    deductions = [{"inventory_item_id": food, "confirmed_amount": 100}]

    first = cook(database, home, deductions, operation=operation, recipe=recipe)
    replay = cook(database, home, deductions, operation=operation, recipe=recipe)
    changed = cook(database, home, [{"inventory_item_id": food, "confirmed_amount": 50}], operation=operation, recipe=recipe, check=False)
    other_snapshot = cook(database, home, deductions, operation=operation, recipe=recipe, snapshot={"recipe_id": recipe, "title": "Other"}, check=False)

    assert replay == first
    assert "different payload" in changed.stderr and "different payload" in other_snapshot.stderr
    assert lot_state(database, own)["quantity"] == 150
    assert database.run(f"SELECT count(*) FROM cook_events WHERE operation_id = {q(operation)}") == "1"


def test_snapshot_must_name_the_recipe(database):
    home = household(database)
    food, _ = lot(database, home, "Salt", "g", 500, "pantry")
    failed = cook(database, home, [{"inventory_item_id": food, "confirmed_amount": 1}], snapshot={"recipe_id": str(uuid4())}, check=False)
    assert "Invalid cook request" in failed.stderr


def at_once(*actions):
    """Start every action together and return their results in order."""
    barrier = Barrier(len(actions))

    def start(action):
        barrier.wait(timeout=5)
        return action()

    with ThreadPoolExecutor(max_workers=len(actions)) as pool:
        return [future.result(timeout=15) for future in [pool.submit(start, a) for a in actions]]


def test_two_phones_cooking_the_same_foods_in_opposite_order_both_finish(database):
    home = household(database)
    milk, milk_lot = lot(database, home, "Milk", "ml", 1000)
    flour, flour_lot = lot(database, home, "Flour", "g", 1000, "pantry")
    forward = [{"inventory_item_id": milk, "confirmed_amount": 100}, {"inventory_item_id": flour, "confirmed_amount": 200}]
    backward = list(reversed(forward))

    for _ in range(5):
        results = at_once(lambda: cook(database, home, forward, check=False), lambda: cook(database, home, backward, check=False))
        assert [r.returncode for r in results] == [0, 0], [r.stderr for r in results]

    assert lot_state(database, milk_lot)["quantity"] == 0
    assert lot_state(database, flour_lot)["quantity"] == 0
    assert database.run(f"SELECT count(*) FROM cook_events WHERE household_id = {q(home)}") == "10"


def test_a_retry_racing_the_first_request_deducts_once(database):
    home = household(database)
    food, own = lot(database, home, "Cream", "ml", 500)
    operation, recipe = str(uuid4()), str(uuid4())
    deductions = [{"inventory_item_id": food, "confirmed_amount": 200}]

    first, retry = at_once(
        lambda: cook(database, home, deductions, operation=operation, recipe=recipe),
        lambda: cook(database, home, deductions, operation=operation, recipe=recipe),
    )

    assert first == retry
    assert lot_state(database, own)["quantity"] == 300
    assert database.run(f"SELECT count(*) FROM cook_events WHERE operation_id = {q(operation)}") == "1"


def test_a_cook_waits_for_a_batch_being_added_and_draws_from_it(database, today):
    home = household(database)
    food, old = lot(database, home, "Spinach", "g", 100, expiration_date=today + timedelta(days=5))

    result = while_holding(
        database,
        add_lot_sql(home, "Spinach", "g", 300, expiration_date=today + timedelta(days=1)),
        lambda: cook(database, home, [{"inventory_item_id": food, "confirmed_amount": 250}]),
        role="authenticated", user=USER,
    )

    [added] = database.run(f"SELECT id FROM lots WHERE food_id = {q(food)} AND id <> {q(old)}").splitlines()
    assert result["deductions"][0]["draws"] == [{"lot_id": added, "amount": 250}]
    assert lot_state(database, old)["quantity"] == 100


class _RpcHttpClient:
    """Stands in for Supabase's REST API by running each RPC call through psql as the JWT's user."""

    def __init__(self, db: DB):
        self.db = db
        self.urls: list[str] = []

    async def post(self, url, *, headers, json, timeout):
        self.urls.append(url)
        user = jwt.get_unverified_claims(headers["Authorization"].removeprefix("Bearer "))["sub"]
        sql = cook_sql(json["p_household_id"], json["p_deductions"], operation=json["p_operation_id"], recipe=json["p_recipe_id"], snapshot=json["p_recipe_snapshot"])
        result = await asyncio.to_thread(self.db.run, sql, role="authenticated", user=user, check=False)
        request = httpx.Request("POST", url)
        if result.returncode:
            return httpx.Response(400, request=request, json={"message": result.stderr})
        return httpx.Response(200, request=request, content=result.stdout.strip())


_KEY = SigningKey("cook-v2")


def headers_for(user: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {_KEY.sign(sub=user)}"}


@pytest.fixture
def api(database, patch_jwks, monkeypatch):
    monkeypatch.setattr(settings, "supabase_url", "https://supabase.test")
    monkeypatch.setattr(settings, "supabase_publishable_key", "key")
    patch_jwks([_KEY])
    with TestClient(create_app()) as client:
        client.app.state.supabase_http_client = _RpcHttpClient(database)
        yield client


def body(home, deductions, operation=None):
    recipe = str(uuid4())
    return {
        "household_id": home, "operation_id": operation or str(uuid4()), "recipe_id": recipe,
        "recipe_snapshot": {"recipe_id": recipe, "title": "Stew"}, "deductions": deductions,
    }


def test_confirm_endpoint_draws_through_cook_recipe_v2_as_the_caller(api, database):
    home = household(database)
    food, own = lot(database, home, "Milk", "ml", 1000)

    response = api.post("/api/cook/confirm", headers=headers_for(USER), json=body(home, [{"inventory_item_id": food, "confirmed_amount": 250}]))

    assert response.status_code == 200
    assert response.json()["data"]["deductions"][0]["draws"] == [{"lot_id": own, "amount": 250}]
    assert api.app.state.supabase_http_client.urls == ["https://supabase.test/rest/v1/rpc/cook_recipe_v2"]
    assert database.run(f"SELECT user_id FROM cook_events WHERE household_id = {q(home)}") == USER
    assert lot_state(database, own)["quantity"] == 750


def test_confirm_endpoint_rejects_another_households_food(api, database):
    home = household(database)
    foreign_home = household(database, member=OTHER)
    foreign_food, foreign_lot = lot(database, foreign_home, "Milk", "ml", 1000, user=OTHER)

    response = api.post("/api/cook/confirm", headers=headers_for(USER), json=body(home, [{"inventory_item_id": foreign_food, "confirmed_amount": 250}]))

    assert response.status_code == 409
    assert response.json()["code"] == "COOK_REJECTED"
    assert lot_state(database, foreign_lot)["quantity"] == 1000


def test_confirm_endpoint_retried_in_parallel_deducts_once(api, database):
    home = household(database)
    food, own = lot(database, home, "Rice", "g", 1000, "pantry")
    request = body(home, [{"inventory_item_id": food, "confirmed_amount": 400}])

    responses = at_once(*[lambda: api.post("/api/cook/confirm", headers=headers_for(USER), json=request)] * 2)

    assert [r.status_code for r in responses] == [200, 200]
    assert responses[0].json() == responses[1].json()
    assert lot_state(database, own)["quantity"] == 600
