"""HTTP-seam tests for the cursor-backed recipe feed."""

from __future__ import annotations

from collections.abc import Sequence
from datetime import date, timedelta
from typing import Any
from uuid import UUID

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.ai.llm.providers import FakeProvider
from app.ai.rag.vector_store import RetrievedRecipe
from app.api.recipes import (
    get_recipe_feed_store,
    get_recipe_provider,
    get_recipe_retriever,
)
from app.main import create_app
from app.services.recipe_feed_store import RecipeFeedSession
from tests.conftest import SigningKey


def _auth_headers(signing_key: SigningKey) -> dict[str, str]:
    return {"Authorization": f"Bearer {signing_key.sign()}"}


def _inventory() -> list[dict[str, Any]]:
    return [
        {
            "id": "spinach",
            "name": "Baby Spinach",
            "quantity": 1,
            "unit": "bag",
            "expiration_date": (date.today() + timedelta(days=2)).isoformat(),
        },
        {
            "id": "tomatoes",
            "name": "Tomatoes",
            "quantity": 3,
            "unit": "item",
            "expiration_date": (date.today() + timedelta(days=30)).isoformat(),
        },
    ]


def _recipe(title: str) -> dict[str, Any]:
    return {
        "title": title,
        "cook_time_minutes": 20,
        "servings": 2,
        "ingredients": [
            {
                "name": "Baby Spinach",
                "inventory_item_id": "spinach",
                "use_amount": 0.5,
                "unit": "bag",
            }
        ],
        "steps": ["Cook the vegetables."],
    }


class StubRetriever:
    def __init__(self) -> None:
        self.calls: list[str] = []

    async def search(self, query: str, **_: Any) -> list[RetrievedRecipe]:
        self.calls.append(query)
        return [
            RetrievedRecipe(
                id=101,
                title="Spinach Inspiration",
                content="Cook spinach.",
                similarity=0.9,
            )
        ]


class InMemoryRecipeFeedStore:
    def __init__(self) -> None:
        self.sessions: dict[UUID, RecipeFeedSession] = {}
        self.items: dict[UUID, list[Any]] = {}

    async def create_session(self, session: RecipeFeedSession) -> None:
        self.sessions[session.id] = session
        self.items[session.id] = []

    async def get_session(
        self, user_id: str, session_id: UUID
    ) -> RecipeFeedSession | None:
        session = self.sessions.get(session_id)
        if session is None or session.user_id != user_id:
            return None
        return session

    async def list_candidates(
        self,
        user_id: str,
        session_id: UUID,
        *,
        start_position: int,
        limit: int,
    ) -> list[Any]:
        session = await self.get_session(user_id, session_id)
        if session is None:
            return []
        return self.items[session_id][start_position : start_position + limit]

    async def append_candidates(
        self,
        user_id: str,
        session_id: UUID,
        *,
        start_position: int,
        recipes: Sequence[Any],
    ) -> None:
        session = await self.get_session(user_id, session_id)
        if session is None:
            raise AssertionError("session not found")
        del start_position
        self.items[session_id].extend(recipes)

    async def update_session(
        self,
        user_id: str,
        session_id: UUID,
        *,
        exclude_titles: list[str],
        candidate_count: int,
        generation_runs: int,
        retrieval_cursor: int,
        has_more: bool,
    ) -> None:
        session = await self.get_session(user_id, session_id)
        if session is None:
            raise AssertionError("session not found")
        self.sessions[session_id] = session.model_copy(
            update={
                "exclude_titles": exclude_titles,
                "candidate_count": candidate_count,
                "generation_runs": generation_runs,
                "retrieval_cursor": retrieval_cursor,
                "has_more": has_more,
            }
        )


def _install_dependencies(
    app: FastAPI,
    provider: Any,
    retriever: Any,
    store: InMemoryRecipeFeedStore,
) -> None:
    app.dependency_overrides[get_recipe_provider] = lambda: provider
    app.dependency_overrides[get_recipe_retriever] = lambda: retriever
    app.dependency_overrides[get_recipe_feed_store] = lambda: store


def test_initial_feed_page_uses_a_five_card_head_batch(
    signing_key: SigningKey,
    patch_jwks,
) -> None:
    patch_jwks([signing_key])
    provider = FakeProvider(
        [{"recipes": [_recipe(f"Recipe {index}") for index in range(1, 11)]}]
    )
    app = create_app()
    _install_dependencies(
        app,
        provider,
        StubRetriever(),
        InMemoryRecipeFeedStore(),
    )

    with TestClient(app) as client:
        response = client.post(
            "/api/recipes/sessions",
            headers=_auth_headers(signing_key),
            json={"inventory": _inventory(), "preferences": {}},
        )

    assert response.status_code == 200
    assert [recipe["title"] for recipe in response.json()["data"]["recipes"]] == [
        "Recipe 1",
        "Recipe 2",
        "Recipe 3",
        "Recipe 4",
        "Recipe 5",
    ]
    assert response.json()["data"]["next_cursor"] == "5"
    assert response.json()["data"]["ready_count"] == 5


def test_initial_feed_keeps_partial_results_without_a_quality_retry(
    signing_key: SigningKey,
    patch_jwks,
) -> None:
    patch_jwks([signing_key])
    invalid_recipe = _recipe("Untracked recipe")
    invalid_recipe["ingredients"][0]["inventory_item_id"] = "not-in-inventory"
    provider = FakeProvider(
        [
            {
                "recipes": [
                    _recipe("Recipe 1"),
                    invalid_recipe,
                ]
            },
            {"recipes": [_recipe("Retry recipe")]},
        ]
    )
    app = create_app()
    _install_dependencies(
        app,
        provider,
        StubRetriever(),
        InMemoryRecipeFeedStore(),
    )

    with TestClient(app) as client:
        response = client.post(
            "/api/recipes/sessions",
            headers=_auth_headers(signing_key),
            json={"inventory": _inventory(), "preferences": {}},
        )

    assert response.status_code == 200
    assert [recipe["title"] for recipe in response.json()["data"]["recipes"]] == [
        "Recipe 1"
    ]
    assert len(provider._responses) == 1


def test_initial_feed_retries_when_no_recipe_passes_quality(
    signing_key: SigningKey,
    patch_jwks,
) -> None:
    patch_jwks([signing_key])
    invalid_recipe = _recipe("Untracked recipe")
    invalid_recipe["ingredients"][0]["inventory_item_id"] = "not-in-inventory"
    provider = FakeProvider(
        [
            {"recipes": [invalid_recipe]},
            {"recipes": [_recipe("Retry recipe")]},
        ]
    )
    app = create_app()
    _install_dependencies(
        app,
        provider,
        StubRetriever(),
        InMemoryRecipeFeedStore(),
    )

    with TestClient(app) as client:
        response = client.post(
            "/api/recipes/sessions",
            headers=_auth_headers(signing_key),
            json={"inventory": _inventory(), "preferences": {}},
        )

    assert response.status_code == 200
    assert [recipe["title"] for recipe in response.json()["data"]["recipes"]] == [
        "Retry recipe"
    ]
    assert len(provider._responses) == 0


def test_refill_returns_partial_results_without_a_second_quality_pass(
    signing_key: SigningKey,
    patch_jwks,
) -> None:
    patch_jwks([signing_key])
    invalid_recipe = _recipe("Untracked refill recipe")
    invalid_recipe["ingredients"][0]["inventory_item_id"] = "not-in-inventory"
    provider = FakeProvider(
        [
            {"recipes": [_recipe(f"Recipe {index}") for index in range(1, 9)]},
            {"recipes": [_recipe("Recipe 9"), invalid_recipe]},
            {"recipes": [_recipe("Retry recipe")]},
        ]
    )
    app = create_app()
    _install_dependencies(
        app,
        provider,
        StubRetriever(),
        InMemoryRecipeFeedStore(),
    )

    with TestClient(app) as client:
        first = client.post(
            "/api/recipes/sessions",
            headers=_auth_headers(signing_key),
            json={"inventory": _inventory(), "preferences": {}},
        )
        session_id = first.json()["data"]["session_id"]
        refill = client.post(
            f"/api/recipes/sessions/{session_id}/pages",
            headers=_auth_headers(signing_key),
            json={"cursor": first.json()["data"]["next_cursor"], "limit": 5},
        )

    assert refill.status_code == 200
    assert [recipe["title"] for recipe in refill.json()["data"]["recipes"]] == [
        "Recipe 9"
    ]
    assert len(provider._responses) == 1


def test_empty_refill_ends_the_feed_with_honest_exhaustion(
    signing_key: SigningKey,
    patch_jwks,
) -> None:
    """A run that adds zero new unique cards ends the feed (ticket #44)."""
    patch_jwks([signing_key])
    provider = FakeProvider(
        [
            {"recipes": [_recipe(f"Recipe {index}") for index in range(1, 9)]},
            {"recipes": []},
            {"recipes": [_recipe("Recipe 9")]},
        ]
    )
    store = InMemoryRecipeFeedStore()
    app = create_app()
    _install_dependencies(app, provider, StubRetriever(), store)

    with TestClient(app) as client:
        first = client.post(
            "/api/recipes/sessions",
            headers=_auth_headers(signing_key),
            json={"inventory": _inventory(), "preferences": {}},
        )
        session_id = first.json()["data"]["session_id"]
        empty_refill = client.post(
            f"/api/recipes/sessions/{session_id}/pages",
            headers=_auth_headers(signing_key),
            json={"cursor": "5", "limit": 5},
        )
        after_exhaustion = client.post(
            f"/api/recipes/sessions/{session_id}/pages",
            headers=_auth_headers(signing_key),
            json={"cursor": "5", "limit": 5},
        )

    assert empty_refill.status_code == 200
    assert empty_refill.json()["data"]["recipes"] == []
    assert empty_refill.json()["data"]["next_cursor"] is None
    assert empty_refill.json()["data"]["has_more"] is False
    # The exhausted session never generates again: the third queued response
    # stays unused and the follow-up page stays empty.
    assert after_exhaustion.status_code == 200
    assert after_exhaustion.json()["data"]["recipes"] == []
    assert after_exhaustion.json()["data"]["has_more"] is False
    assert len(provider._responses) == 1


def test_session_with_zero_valid_recipes_returns_explicit_empty_state(
    signing_key: SigningKey,
    patch_jwks,
) -> None:
    """Zero survivors is a 200 with an explicit reason, never a 503."""
    patch_jwks([signing_key])
    invalid_recipe = _recipe("Untracked recipe")
    invalid_recipe["ingredients"][0]["inventory_item_id"] = "not-in-inventory"
    provider = FakeProvider(
        [
            {"recipes": [invalid_recipe]},
            {"recipes": [invalid_recipe]},
        ]
    )
    app = create_app()
    _install_dependencies(
        app,
        provider,
        StubRetriever(),
        InMemoryRecipeFeedStore(),
    )

    with TestClient(app) as client:
        response = client.post(
            "/api/recipes/sessions",
            headers=_auth_headers(signing_key),
            json={"inventory": _inventory(), "preferences": {}},
        )

    assert response.status_code == 200
    assert response.json()["data"]["recipes"] == []
    assert response.json()["data"]["empty_reason"] == "INVENTORY_UNSUPPORTED"
    assert response.json()["data"]["has_more"] is False
    assert response.json()["data"]["next_cursor"] is None


def test_feed_stops_generating_at_the_six_run_session_cap(
    signing_key: SigningKey,
    patch_jwks,
) -> None:
    """The session cap guards tail quality: six runs, then honest exhaustion."""
    patch_jwks([signing_key])
    responses = [
        {
            "recipes": [
                _recipe(f"Run {run} recipe {index}") for index in range(1, 6)
            ]
        }
        for run in range(1, 8)
    ]
    provider = FakeProvider(responses)
    store = InMemoryRecipeFeedStore()
    app = create_app()
    _install_dependencies(app, provider, StubRetriever(), store)

    with TestClient(app) as client:
        first = client.post(
            "/api/recipes/sessions",
            headers=_auth_headers(signing_key),
            json={"inventory": _inventory(), "preferences": {}},
        )
        session_id = first.json()["data"]["session_id"]
        cursor = first.json()["data"]["next_cursor"]
        pages = []
        while cursor is not None:
            page = client.post(
                f"/api/recipes/sessions/{session_id}/pages",
                headers=_auth_headers(signing_key),
                json={"cursor": cursor, "limit": 5},
            )
            assert page.status_code == 200
            pages.append(page.json()["data"])
            cursor = page.json()["data"]["next_cursor"]

    assert pages[-1]["has_more"] is False
    assert pages[-1]["ready_count"] == 30
    assert len(provider._responses) == 1


def test_feed_pages_from_a_server_owned_pool_before_refilling(
    signing_key: SigningKey,
    patch_jwks,
) -> None:
    patch_jwks([signing_key])
    provider = FakeProvider(
        [
            {"recipes": [_recipe(f"Recipe {index}") for index in range(1, 6)]},
            {"recipes": [_recipe("Recipe 11"), _recipe("Recipe 12")]},
        ]
    )
    retriever = StubRetriever()
    store = InMemoryRecipeFeedStore()
    app = create_app()
    _install_dependencies(app, provider, retriever, store)

    with TestClient(app) as client:
        first = client.post(
            "/api/recipes/sessions",
            headers=_auth_headers(signing_key),
            json={"inventory": _inventory(), "preferences": {"meal": "dinner"}},
        )
        session_id = first.json()["data"]["session_id"]
        second = client.post(
            f"/api/recipes/sessions/{session_id}/pages",
            headers=_auth_headers(signing_key),
            json={"cursor": "2", "limit": 2},
        )
        invalid = client.post(
            f"/api/recipes/sessions/{session_id}/pages",
            headers=_auth_headers(signing_key),
            json={"cursor": "6", "limit": 5},
        )
        third = client.post(
            f"/api/recipes/sessions/{session_id}/pages",
            headers=_auth_headers(signing_key),
            json={"cursor": "5", "limit": 5},
        )

    assert first.status_code == 200
    assert [recipe["title"] for recipe in first.json()["data"]["recipes"]] == [
        "Recipe 1",
        "Recipe 2",
        "Recipe 3",
        "Recipe 4",
        "Recipe 5",
    ]
    assert first.json()["data"]["next_cursor"] == "5"

    assert second.status_code == 200
    assert [recipe["title"] for recipe in second.json()["data"]["recipes"]] == [
        "Recipe 3",
        "Recipe 4",
    ]
    assert retriever.calls == ["baby spinach tomatoes"]

    assert invalid.status_code == 422
    assert invalid.json()["code"] == "RECIPE_FEED_INVALID_CURSOR"

    assert third.status_code == 200
    assert [recipe["title"] for recipe in third.json()["data"]["recipes"]] == [
        "Recipe 11",
        "Recipe 12",
    ]
    assert third.json()["data"]["session_id"] == session_id
    assert len(provider._responses) == 0


class PromptRecordingProvider:
    """FakeProvider wrapper that captures each generation prompt."""

    def __init__(self, responses: list[Any]) -> None:
        self._inner = FakeProvider(responses)
        self.prompts: list[str] = []

    async def generate(
        self,
        prompt: str,
        *,
        response_model: Any,
        system_instruction: Any = None,
        deadline: Any = None,
    ) -> Any:
        self.prompts.append(prompt)
        return await self._inner.generate(
            prompt,
            response_model=response_model,
            system_instruction=system_instruction,
            deadline=deadline,
        )


class PoolRetriever:
    """Return a deterministic pool larger than one generation window."""

    def __init__(self, count: int) -> None:
        self._count = count

    async def search(self, query: str, **_: Any) -> list[RetrievedRecipe]:
        return [
            RetrievedRecipe(
                id=index,
                title=f"Doc {index:02d}",
                content=f"Inspiration {index:02d}.",
                similarity=0.9,
            )
            for index in range(1, self._count + 1)
        ]


def test_refill_runs_never_reuse_grounding_docs_from_earlier_runs(
    signing_key: SigningKey,
    patch_jwks,
) -> None:
    """Each run draws the next retrieval window (tail-quality guard, #44)."""
    patch_jwks([signing_key])
    provider = PromptRecordingProvider(
        [
            {"recipes": [_recipe(f"Recipe {index}") for index in range(1, 6)]},
            {"recipes": [_recipe("Recipe 6")]},
        ]
    )
    store = InMemoryRecipeFeedStore()
    app = create_app()
    _install_dependencies(app, provider, PoolRetriever(12), store)

    with TestClient(app) as client:
        first = client.post(
            "/api/recipes/sessions",
            headers=_auth_headers(signing_key),
            json={"inventory": _inventory(), "preferences": {}},
        )
        session_id = first.json()["data"]["session_id"]
        client.post(
            f"/api/recipes/sessions/{session_id}/pages",
            headers=_auth_headers(signing_key),
            json={"cursor": "5", "limit": 5},
        )

    initial_prompt, refill_prompt = provider.prompts
    assert "Doc 01" in initial_prompt and "Doc 05" in initial_prompt
    assert "Doc 06" not in initial_prompt
    assert "Doc 06" in refill_prompt and "Doc 10" in refill_prompt
    assert "Doc 01" not in refill_prompt and "Doc 11" not in refill_prompt


def test_feed_page_does_not_cross_user_session_boundaries(
    signing_key: SigningKey,
    patch_jwks,
) -> None:
    patch_jwks([signing_key])
    app = create_app()
    _install_dependencies(
        app,
        FakeProvider([]),
        StubRetriever(),
        InMemoryRecipeFeedStore(),
    )

    with TestClient(app) as client:
        response = client.post(
            "/api/recipes/sessions/00000000-0000-0000-0000-000000000099/pages",
            headers=_auth_headers(signing_key),
            json={"cursor": "0"},
        )

    assert response.status_code == 404
    assert response.json()["code"] == "RECIPE_FEED_NOT_FOUND"
