"""HTTP contract tests for cook confirmation error handling."""

# ruff: noqa: E501

from __future__ import annotations

import httpx
import pytest

from tests.conftest import SigningKey


def payload(amount: object = 1) -> dict[str, object]:
    recipe_id = "11111111-1111-1111-1111-111111111111"
    return {
        "household_id": "22222222-2222-2222-2222-222222222222",
        "operation_id": "33333333-3333-3333-3333-333333333333",
        "recipe_id": recipe_id,
        "recipe_snapshot": {"recipe_id": recipe_id, "title": "Beans"},
        "deductions": [{"inventory_item_id": "44444444-4444-4444-4444-444444444444", "confirmed_amount": amount}],
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
