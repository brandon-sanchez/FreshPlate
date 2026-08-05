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
async def test_store_forwards_user_jwt_and_persists_stable_positions() -> None:
    session_id = UUID("00000000-0000-0000-0000-000000000020")
    row = _session_row(session_id)
    client = FakeHttpClient(
        [
            httpx.Response(201, json=[row]),
            httpx.Response(200, json=[row]),
            httpx.Response(
                200,
                json=[{"position": 0, "recipe": _recipe().model_dump(mode="json")}],
            ),
            httpx.Response(204),
            httpx.Response(200, json=[row]),
        ]
    )
    store = SupabaseRecipeFeedStore(
        "user-jwt",
        url="https://project.supabase.co",
        publishable_key="publishable-key",
        http_client=client,
    )
    session = RecipeFeedSession.model_validate(row)

    await store.create_session(session)
    assert await store.get_session(session.user_id, session.id) == session
    assert await store.list_candidates(
        session.user_id,
        session.id,
        start_position=0,
        limit=5,
    ) == [_recipe()]
    await store.append_candidates(
        session.user_id,
        session.id,
        start_position=1,
        recipes=[_recipe("Spinach Soup")],
    )
    await store.update_session(
        session.user_id,
        session.id,
        exclude_titles=["Spinach Pasta"],
        candidate_count=2,
        generation_runs=2,
        retrieval_cursor=5,
        has_more=True,
    )

    assert len(client.calls) == 5
    for call in client.calls:
        assert call["headers"]["apikey"] == "publishable-key"
        assert call["headers"]["Authorization"] == "Bearer user-jwt"
    append_call = client.calls[3]
    assert "on_conflict=session_id,position" in append_call["url"]
    assert append_call["json"][0]["position"] == 1
    assert append_call["json"][0]["user_id"] == session.user_id
