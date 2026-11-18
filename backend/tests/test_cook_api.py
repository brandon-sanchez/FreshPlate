"""HTTP contract tests for cook confirmation error handling."""

# ruff: noqa: E501

from __future__ import annotations

import httpx
import pytest

from tests.conftest import SigningKey


def payload(amount: object = 1, expected: object = 1) -> dict[str, object]:
    recipe_id = "11111111-1111-1111-1111-111111111111"
    return {
        "household_id": "22222222-2222-2222-2222-222222222222",
        "operation_id": "33333333-3333-3333-3333-333333333333",
        "recipe_id": recipe_id,
        "recipe_snapshot": {"recipe_id": recipe_id, "title": "Beans"},
        "deductions": [{"inventory_item_id": "44444444-4444-4444-4444-444444444444", "confirmed_amount": amount, "expected_amount": expected}],
        "lines": [{
            "ingredient": "beans", "inventory_item_id": "44444444-4444-4444-4444-444444444444",
            "recipe_amount": 1, "recipe_unit": "can", "mode": "draw", "stock_amount": 1,
        }],
    }


def test_anonymous_is_rejected(client):
    response = client.post("/api/cook/confirm", json=payload())
    assert response.status_code == 401


@pytest.mark.parametrize("status", [401, 403])
def test_supabase_auth_status_is_preserved(client, signing_key: SigningKey, patch_jwks, monkeypatch, status):
    patch_jwks([signing_key])
    monkeypatch.setattr("app.api.cook.settings.supabase_url", "https://supabase.test")
    monkeypatch.setattr("app.api.cook.settings.supabase_publishable_key", "key")

    async def post(*args, **kwargs):
        return httpx.Response(status, request=httpx.Request("POST", "https://supabase.test"))

    monkeypatch.setattr(httpx.AsyncClient, "post", post)
    client.app.state.supabase_http_client = httpx.AsyncClient()
    response = client.post("/api/cook/confirm", headers={"Authorization": f"Bearer {signing_key.sign()}"}, json=payload())
    assert response.status_code == status


def test_supabase_timeout_is_canonical_unavailable(client, signing_key: SigningKey, patch_jwks, monkeypatch):
    patch_jwks([signing_key])
    monkeypatch.setattr("app.api.cook.settings.supabase_url", "https://supabase.test")
    monkeypatch.setattr("app.api.cook.settings.supabase_publishable_key", "key")

    async def post(*args, **kwargs):
        raise httpx.ReadTimeout("timed out")

    monkeypatch.setattr(httpx.AsyncClient, "post", post)
    client.app.state.supabase_http_client = httpx.AsyncClient()
    response = client.post("/api/cook/confirm", headers={"Authorization": f"Bearer {signing_key.sign()}"}, json=payload())
    assert response.status_code == 503
    assert response.json()["code"] == "COOK_UNAVAILABLE"


def test_infinite_amount_is_rejected(client, signing_key: SigningKey, patch_jwks):
    patch_jwks([signing_key])
    response = client.post("/api/cook/confirm", headers={"Authorization": f"Bearer {signing_key.sign()}"}, json=payload("Infinity"))
    assert response.status_code == 422


@pytest.mark.parametrize(
    "change",
    [
        {"lines": [{**payload()["lines"][0], "mode": "guess"}]},
        {"lines": [{**payload()["lines"][0], "stock_amount": "Infinity"}]},
        {"lines": [{**payload()["lines"][0], "recipe_amount": -1}]},
        {"lines": [{**payload()["lines"][0], "stock_amount": None}]},
        {"lines": [{**payload()["lines"][0], "mode": "small"}]},
        {"lines": [{**payload()["lines"][0], "ingredient": "  "}]},
        {"lines": [{**payload()["lines"][0], "recipe_unit": ""}]},
    ],
)
def test_malformed_lines_are_rejected_before_supabase(client, signing_key: SigningKey, patch_jwks, change):
    patch_jwks([signing_key])
    response = client.post("/api/cook/confirm", headers={"Authorization": f"Bearer {signing_key.sign()}"}, json={**payload(), **change})
    assert response.status_code == 422


@pytest.mark.parametrize("expected", [-1, 2, "NaN", None])
def test_an_expected_amount_outside_zero_to_confirmed_is_rejected(client, signing_key: SigningKey, patch_jwks, expected):
    patch_jwks([signing_key])
    response = client.post("/api/cook/confirm", headers={"Authorization": f"Bearer {signing_key.sign()}"}, json=payload(1, expected))
    assert response.status_code == 422


def test_a_cook_with_nothing_used_reaches_supabase(client, signing_key: SigningKey, patch_jwks, monkeypatch):
    patch_jwks([signing_key])
    monkeypatch.setattr("app.api.cook.settings.supabase_url", "https://supabase.test")
    monkeypatch.setattr("app.api.cook.settings.supabase_publishable_key", "key")
    sent = []

    async def post(self, url, **kwargs):
        sent.append(kwargs["json"])
        return httpx.Response(200, request=httpx.Request("POST", url), json={"deductions": [], "lines": []})

    monkeypatch.setattr(httpx.AsyncClient, "post", post)
    client.app.state.supabase_http_client = httpx.AsyncClient()
    response = client.post("/api/cook/confirm", headers={"Authorization": f"Bearer {signing_key.sign()}"}, json={**payload(), "deductions": [], "lines": []})
    assert response.status_code == 200
    assert (sent[0]["p_deductions"], sent[0]["p_lines"]) == ([], [])


@pytest.mark.parametrize(
    ("body", "code"),
    [
        ({"code": "22023", "message": "STOCK_CHANGED", "details": "[]", "hint": None}, "STOCK_CHANGED"),
        ({"code": "22023", "message": "COOK_ALREADY_CONFIRMED", "details": "x", "hint": None}, "COOK_ALREADY_CONFIRMED"),
        ({"code": "22023", "message": "FOOD_NOT_FOUND", "details": "x", "hint": None}, "COOK_REJECTED"),
        ({"message": "not json the way PostgREST sends it"}, "COOK_REJECTED"),
    ],
)
def test_a_refused_cook_says_why_when_the_app_can_act_on_it(client, signing_key: SigningKey, patch_jwks, monkeypatch, body, code):
    patch_jwks([signing_key])
    monkeypatch.setattr("app.api.cook.settings.supabase_url", "https://supabase.test")
    monkeypatch.setattr("app.api.cook.settings.supabase_publishable_key", "key")

    async def post(self, url, **kwargs):
        return httpx.Response(400, request=httpx.Request("POST", url), json=body)

    monkeypatch.setattr(httpx.AsyncClient, "post", post)
    client.app.state.supabase_http_client = httpx.AsyncClient()
    response = client.post("/api/cook/confirm", headers={"Authorization": f"Bearer {signing_key.sign()}"}, json=payload())
    assert response.status_code == 409
    assert response.json()["code"] == code
