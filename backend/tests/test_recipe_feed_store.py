"""PostgREST contract tests for recipe feed session persistence."""

from __future__ import annotations

from typing import Any
from uuid import UUID

import httpx
import pytest

from app.models.recipes import RecipeSuggestion
from app.services.recipe_feed_store import (
    RecipeFeedSession,
    SupabaseRecipeFeedStore,
)


def _recipe(title: str = "Spinach Pasta") -> RecipeSuggestion:
    return RecipeSuggestion.model_validate(
        {
            "recipe_id": "00000000-0000-0000-0000-000000000010",
            "title": title,
            "cook_time_minutes": 20,
            "servings": 2,
            "ingredients": [
                {
                    "name": "Spinach",
                    "inventory_item_id": "spinach",
                    "use_amount": 1,
                    "unit": "bag",
                }
            ],
            "steps": ["Cook it."],
            "match_percent": 100,
            "saves_expiring": [],
        }
    )


def _session_row(session_id: UUID) -> dict[str, Any]:
    return {
        "id": str(session_id),
        "user_id": "00000000-0000-0000-0000-000000000001",
        "inventory": [],
        "preferences": {"meal": "dinner"},
        "usable_items": [],
        "retrieved_recipes": [],
        "exclude_titles": [],
        "candidate_count": 1,
        "generation_runs": 1,
        "has_more": True,
        "created_at": "2026-08-04T22:00:00+00:00",
        "expires_at": "2026-08-05T00:00:00+00:00",
    }


class FakeHttpClient:
    def __init__(self, responses: list[httpx.Response]) -> None:
        self.responses = responses
        self.calls: list[dict[str, Any]] = []

    async def request(self, method: str, url: str, **kwargs: Any) -> httpx.Response:
        self.calls.append({"method": method, "url": url, **kwargs})
        response = self.responses.pop(0)
        response.request = httpx.Request(method, url)
        return response


@pytest.mark.asyncio
async def test_store_uses_scoped_reads_and_backend_only_atomic_writes() -> None:
    session_id = UUID("00000000-0000-0000-0000-000000000020")
    claim_id = UUID("00000000-0000-0000-0000-000000000021")
    row = _session_row(session_id)
    client = FakeHttpClient(
        [
            httpx.Response(200, json=[row]),
            httpx.Response(200, json=[row]),
            httpx.Response(200, json=[{"recipe": _recipe().model_dump(mode="json")}]),
            httpx.Response(200, json=[{**row, "refill_claim_id": str(claim_id)}]),
            httpx.Response(200, json=[row]),
        ]
    )
    store = SupabaseRecipeFeedStore(
        "user-jwt",
        url="https://project.supabase.co",
        publishable_key="publishable-key",
        secret_key="backend-secret",
        http_client=client,
    )
    session = RecipeFeedSession.model_validate(row)
    await store.create_session(session, recipes=[_recipe()])
    assert await store.get_session(session.user_id, session.id) == session
    assert await store.list_candidates(
        session.user_id, session.id, start_position=0, limit=5
    ) == [_recipe()]
    claimed = await store.claim_refill(
        session.user_id,
        session.id,
        expected_generation_runs=1,
        claim_id=claim_id,
    )
    assert claimed.refill_claim_id == claim_id
    await store.finalize_refill(
        session.user_id,
        session.id,
        claim_id=claim_id,
        recipes=[_recipe("Spinach Soup")],
        exclude_titles=["Spinach Pasta"],
        retrieval_cursor=5,
    )
    for index in (0, 3, 4):
        assert client.calls[index]["headers"]["apikey"] == "backend-secret"
        assert "Authorization" not in client.calls[index]["headers"]
        assert client.calls[index]["json"]["p_user_id"] == session.user_id
    for index in (1, 2):
        assert client.calls[index]["headers"]["apikey"] == "publishable-key"
        assert client.calls[index]["headers"]["Authorization"] == "Bearer user-jwt"
        assert client.calls[index]["params"]["user_id"] == f"eq.{session.user_id}"
    assert client.calls[0]["url"].endswith("/rpc/create_recipe_feed_session")
    assert client.calls[0]["json"]["p_recipes"] == [_recipe().model_dump(mode="json")]
    assert client.calls[3]["url"].endswith("/rpc/claim_recipe_feed_refill")
    assert client.calls[4]["url"].endswith("/rpc/finalize_recipe_feed_refill")
    assert client.calls[4]["json"]["p_claim_id"] == str(claim_id)


@pytest.mark.asyncio
async def test_store_legacy_backend_key_is_not_the_user_jwt() -> None:
    row = _session_row(UUID("00000000-0000-0000-0000-000000000020"))
    client = FakeHttpClient([httpx.Response(200, json=[row])])
    store = SupabaseRecipeFeedStore(
        "user-jwt",
        url="https://project.supabase.co",
        anon_key="anon-key",
        service_role_key="service-jwt",
        http_client=client,
    )
    await store.create_session(RecipeFeedSession.model_validate(row))
    assert client.calls[0]["headers"]["apikey"] == "service-jwt"
    assert client.calls[0]["headers"]["Authorization"] == "Bearer service-jwt"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "url",
    [
        "http://project.supabase.co",
        "http://localhost.evil.test",
        "ftp://127.0.0.1",
    ],
)
async def test_store_rejects_insecure_origins_before_transmitting_credentials(
    url,
) -> None:
    from app.services.recipe_feed_store import RecipeFeedStoreError

    client = FakeHttpClient([])
    store = SupabaseRecipeFeedStore(
        "user-jwt",
        url=url,
        anon_key="anon-key",
        secret_key="backend-secret",
        http_client=client,
    )
    with pytest.raises(RecipeFeedStoreError, match="secure origin"):
        await store.get_session("user", UUID(int=1))
    assert client.calls == []


@pytest.mark.asyncio
async def test_store_allows_loopback_http_for_local_supabase() -> None:
    client = FakeHttpClient([httpx.Response(200, json=[])])
    store = SupabaseRecipeFeedStore(
        "local-jwt",
        url="http://127.0.0.1:54321",
        anon_key="local-anon",
        http_client=client,
    )
    assert await store.get_session("user", UUID(int=1)) is None
    assert client.calls[0]["url"].startswith("http://127.0.0.1:54321/")
