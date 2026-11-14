"""PostgREST requests made by the backend food profile store."""

from __future__ import annotations

from decimal import Decimal

import httpx
import pytest

from app.inventory.fact_estimates import ProfileEstimate
from app.services.food_profile_store import (
    FoodProfileStoreError,
    SupabaseFoodProfileStore,
)
from tests.estimate_support import SUPABASE_URL, StoreServer, food_row


@pytest.mark.asyncio
async def test_lists_every_page_of_unestimated_live_food_facts():
    rows = [food_row(id=f"food-{index:04}") for index in range(1001)]
    server = StoreServer(rows)
    listed = await server.store().list_unestimated_food_facts()
    assert [row["id"] for row in listed] == [row["id"] for row in rows]
    first, second, third = server.requests
    assert first.url.path == "/rest/v1/food_facts"
    assert dict(first.url.params) == {
        "archived_at": "is.null",
        "profile_estimated_at": "is.null",
        "order": "id",
        "limit": "1000",
        "offset": "0",
    }
    assert second.url.params["offset"] == "1000"
    assert third.url.params["offset"] == "1001"
    assert first.headers["apikey"] == "sb_secret_test"
    assert "authorization" not in first.headers


@pytest.mark.asyncio
async def test_legacy_service_role_key_is_also_sent_as_a_bearer_token():
    server = StoreServer()
    await server.store(
        secret_key=None, service_role_key="legacy-jwt"
    ).list_unestimated_food_facts()
    assert server.requests[0].headers["authorization"] == "Bearer legacy-jwt"


@pytest.mark.asyncio
async def test_save_estimate_posts_numbers_to_the_rpc_and_returns_the_profile():
    server = StoreServer(resolve=lambda body: "garlic")
    estimate = ProfileEstimate(
        profile_name="garlic",
        estimated_by="gemini-3.6-flash",
        unit_grams={"head": Decimal("40.5")},
    )
    assert await server.store().save_estimate("food-1", estimate) == "garlic"
    request = server.requests[0]
    assert request.url.path == "/rest/v1/rpc/save_food_profile_estimate"
    assert server.saves == [
        {
            "p_food_id": "food-1",
            "p_profile_name": "garlic",
            "p_g_per_ml": None,
            "p_unit_grams": {"head": 40.5},
            "p_estimated_by": "gemini-3.6-flash",
        }
    ]


@pytest.mark.asyncio
async def test_rpc_errors_raise_the_store_error():
    def missing_food(request: httpx.Request) -> httpx.Response:
        return httpx.Response(404, json={"code": "P0002"})

    store = SupabaseFoodProfileStore(
        SUPABASE_URL,
        secret_key="sb_secret_test",
        http_client=httpx.AsyncClient(transport=httpx.MockTransport(missing_food)),
    )
    estimate = ProfileEstimate(profile_name="garlic", estimated_by="gemini-3.6-flash")
    with pytest.raises(FoodProfileStoreError, match="HTTP 404"):
        await store.save_estimate("food-1", estimate)


@pytest.mark.asyncio
async def test_insecure_urls_are_refused_before_any_request():
    server = StoreServer()
    store = SupabaseFoodProfileStore(
        "http://project.supabase.co",
        secret_key="sb_secret_test",
        http_client=httpx.AsyncClient(transport=httpx.MockTransport(server.handler)),
    )
    with pytest.raises(FoodProfileStoreError):
        await store.list_unestimated_food_facts()
    assert server.requests == []
