"""Supabase requests made by the image ledger, Storage and subject adapters."""

from __future__ import annotations

import json
from uuid import uuid4

import httpx
import pytest
from pydantic import SecretStr

from app.services.image_service import ClaimLimits, ImageStoreError
from app.services.image_store import SupabaseImageStore, SupabaseImageSubjects
from tests.image_fakes import recipe

pytestmark = pytest.mark.asyncio

RECIPE_ID = uuid4()
USER = "00000000-0000-0000-0000-000000000001"


@pytest.fixture
def supabase(monkeypatch):
    monkeypatch.setattr(
        "app.services.image_store.settings.supabase_url", "https://sb.test"
    )
    monkeypatch.setattr(
        "app.services.image_store.settings.supabase_publishable_key", "sb_publishable"
    )
    monkeypatch.setattr(
        "app.services.image_store.settings.supabase_secret_key", SecretStr("sb_secret")
    )
    requests: list[httpx.Request] = []
    responses: list[httpx.Response] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return responses.pop(0)

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    return client, requests, responses


async def test_feed_recipe_read_is_scoped_to_the_caller(supabase):
    client, requests, responses = supabase
    stored = recipe().model_dump(mode="json")
    responses.append(httpx.Response(200, json=[{"recipe": stored}]))
    subjects = SupabaseImageSubjects(client, "user-jwt")
    found = await subjects.find_feed_recipe(USER, RECIPE_ID)
    assert found is not None and found.title == stored["title"]
    [feed] = requests
    assert feed.url.path == "/rest/v1/recipe_feed_items"
    assert feed.url.params["user_id"] == f"eq.{USER}"
    assert feed.url.params["recipe->>recipe_id"] == f"eq.{RECIPE_ID}"
    assert feed.headers["authorization"] == "Bearer user-jwt"
    assert feed.headers["apikey"] == "sb_publishable"


async def test_saved_recipe_and_food_reads_rely_on_household_rls(supabase):
    client, requests, responses = supabase
    responses += [httpx.Response(200, json=[]), httpx.Response(200, json=[])]
    subjects = SupabaseImageSubjects(client, "user-jwt")
    assert await subjects.find_saved_recipe(RECIPE_ID) is None
    assert await subjects.find_food(uuid4()) is None
    saved, food = requests
    assert saved.url.path == "/rest/v1/saved_recipes"
    assert food.url.path == "/rest/v1/food_facts"
    assert {r.headers["authorization"] for r in requests} == {"Bearer user-jwt"}


async def test_invalid_stored_recipe_is_a_store_error(supabase):
    client, _, responses = supabase
    responses.append(httpx.Response(200, json=[{"recipe": {"title": "x"}}]))
    with pytest.raises(ImageStoreError):
        await SupabaseImageSubjects(client, "jwt").find_saved_recipe(RECIPE_ID)


async def test_ledger_and_storage_use_the_backend_key(supabase):
    client, requests, responses = supabase
    asset, reservation = uuid4(), uuid4()
    responses += [
        httpx.Response(
            200,
            json=[
                {
                    "outcome": "claimed",
                    "asset_id": str(asset),
                    "reservation_id": str(reservation),
                    "object_path": None,
                }
            ],
        ),
        httpx.Response(200, json={"Key": "generated-images/recipe/k.webp"}),
        httpx.Response(200, json=True),
        httpx.Response(
            200,
            json={"signedURL": "/object/sign/generated-images/recipe/k.webp?token=t"},
        ),
    ]
    store = SupabaseImageStore(client)
    limits = ClaimLimits(
        cost_microusd=60,
        cap_microusd=100,
        requester_cap_microusd=50,
        max_attempts=2,
        retry_after_seconds=900,
        lease_seconds=180,
    )
    claim = await store.claim("recipe", "k", USER, limits)
    assert claim.outcome == "claimed" and claim.reservation_id == reservation
    await store.upload("recipe/k.webp", b"webp")
    assert await store.settle(asset, reservation, "recipe/k.webp") is True
    url = await store.signed_url("recipe/k.webp", 3600)
    assert url == (
        "https://sb.test/storage/v1/object/sign/generated-images/recipe/k.webp?token=t"
    )
    rpc, upload, _, sign = requests
    assert json.loads(rpc.content) == {
        "p_kind": "recipe",
        "p_cache_key": "k",
        "p_requester": USER,
        "p_cost_microusd": 60,
        "p_monthly_cap_microusd": 100,
        "p_requester_cap_microusd": 50,
        "p_max_attempts": 2,
        "p_retry_after_seconds": 900,
        "p_lease_seconds": 180,
    }
    assert upload.url.path == "/storage/v1/object/generated-images/recipe/k.webp"
    assert upload.headers["content-type"] == "image/webp"
    assert upload.headers["x-upsert"] == "true"
    assert json.loads(sign.content) == {"expiresIn": 3600}
    for request in requests:
        assert request.headers["apikey"] == "sb_secret"
        assert "authorization" not in request.headers


async def test_supabase_errors_become_image_store_errors(supabase):
    client, _, responses = supabase
    responses.append(httpx.Response(500))
    with pytest.raises(ImageStoreError):
        await SupabaseImageStore(client).find_ready("recipe", "k")
