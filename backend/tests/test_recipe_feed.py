"""HTTP-seam tests for the cursor-backed recipe feed."""

from __future__ import annotations

from collections.abc import Sequence
from datetime import date, datetime, timedelta, timezone
from typing import Any
from uuid import UUID

import pytest
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
from app.services.recipe_feed_store import RecipeFeedSession, RecipeFeedStoreError
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


def _assessment(count: int) -> dict[str, Any]:
    return {
        "decisions": [
            {
                "candidate_index": index,
                "verdict": "eligible",
                "reason": "complete meal",
            }
            for index in range(count)
        ]
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

    async def create_session(
        self, session: RecipeFeedSession, *, recipes: Sequence[Any] = ()
    ) -> None:
        self.sessions[session.id] = session
        self.items[session.id] = list(recipes)

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

    async def claim_refill(
        self,
        user_id,
        session_id,
        *,
        expected_generation_runs,
        claim_id,
    ) -> RecipeFeedSession:
        session = await self.get_session(user_id, session_id)
        assert session is not None
        if (
            session.refill_claim_expires_at is not None
            and session.refill_claim_expires_at > datetime.now(timezone.utc)
        ) or session.generation_runs != expected_generation_runs:
            return session
        if (
            not session.has_more
            or not session.usable_items
            or session.generation_runs >= 6
        ):
            updates = {
                "has_more": False,
                "refill_claim_id": None,
                "refill_claim_expires_at": None,
            }
        else:
            updates = {
                "generation_runs": session.generation_runs + 1,
                "refill_claim_id": claim_id,
                "refill_claim_expires_at": datetime.now(timezone.utc)
                + timedelta(seconds=45),
            }
        self.sessions[session_id] = session.model_copy(update=updates)
        return self.sessions[session_id]

    async def finalize_refill(
        self,
        user_id,
        session_id,
        *,
        claim_id,
        recipes,
        exclude_titles,
        retrieval_cursor,
    ) -> RecipeFeedSession:
        session = await self.get_session(user_id, session_id)
        assert session is not None
        if session.completed_refill_claim_id == claim_id:
            return session
        if session.refill_claim_id != claim_id:
            raise RecipeFeedStoreError("Stale refill claim")
        self.items[session_id].extend(recipes)
        self.sessions[session_id] = session.model_copy(
            update={
                "candidate_count": session.candidate_count + len(recipes),
                "exclude_titles": exclude_titles,
                "retrieval_cursor": retrieval_cursor,
                "has_more": bool(recipes) and session.generation_runs < 6,
                "completed_refill_claim_id": claim_id,
                "refill_claim_id": None,
                "refill_claim_expires_at": None,
            }
        )
        return self.sessions[session_id]

    async def release_refill(self, user_id, session_id, *, claim_id):
        session = await self.get_session(user_id, session_id)
        if session and session.refill_claim_id == claim_id:
            self.sessions[session_id] = session.model_copy(
                update={
                    "refill_claim_id": None,
                    "refill_claim_expires_at": None,
                    "has_more": session.has_more and session.generation_runs < 6,
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
        [
            {"recipes": [_recipe(f"Recipe {index}") for index in range(1, 11)]},
            _assessment(5),
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
            _assessment(1),
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
            _assessment(1),
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
            _assessment(5),
            {"recipes": [_recipe("Recipe 9"), invalid_recipe]},
            _assessment(1),
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
            _assessment(5),
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
    responses = []
    for run in range(1, 8):
        responses.extend(
            [
                {
                    "recipes": [
                        _recipe(f"Run {run} recipe {index}")
                        for index in range(1, 6)
                    ]
                },
                _assessment(5),
            ]
        )
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
    assert len(provider._responses) == 2


def test_feed_pages_from_a_server_owned_pool_before_refilling(
    signing_key: SigningKey,
    patch_jwks,
) -> None:
    patch_jwks([signing_key])
    provider = FakeProvider(
        [
            {"recipes": [_recipe(f"Recipe {index}") for index in range(1, 6)]},
            _assessment(5),
            {"recipes": [_recipe("Recipe 11"), _recipe("Recipe 12")]},
            _assessment(2),
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
            _assessment(5),
            {"recipes": [_recipe("Recipe 6")]},
            _assessment(1),
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

    initial_prompt, refill_prompt = [
        prompt for prompt in provider.prompts if prompt.startswith("Create up")
    ]
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
    provider = FakeProvider(
        [{"recipes": [_recipe("Private recipe")]}, _assessment(1)]
    )
    _install_dependencies(app, provider, StubRetriever(), InMemoryRecipeFeedStore())
    with TestClient(app) as client:
        first = client.post(
            "/api/recipes/sessions",
            headers=_auth_headers(signing_key),
            json={"inventory": _inventory()},
        )
        assert first.status_code == 200
        session_id = first.json()["data"]["session_id"]
        owner = client.post(
            f"/api/recipes/sessions/{session_id}/pages",
            headers=_auth_headers(signing_key),
            json={"cursor": "0", "limit": 1},
        )
        response = client.post(
            f"/api/recipes/sessions/{session_id}/pages",
            headers={
                "Authorization": "Bearer "
                + signing_key.sign(sub="00000000-0000-0000-0000-000000000002")
            },
            json={"cursor": "0", "limit": 1},
        )
    assert owner.status_code == 200
    assert owner.json()["data"]["recipes"][0]["title"] == "Private recipe"
    assert response.status_code == 404
    assert response.json()["code"] == "RECIPE_FEED_NOT_FOUND"


def test_feed_keeps_items_without_a_searchable_name(signing_key, patch_jwks) -> None:
    patch_jwks([signing_key])
    provider = PromptRecordingProvider(
        [{"recipes": [_recipe("Spinach dinner")]}, _assessment(1)]
    )
    retriever = StubRetriever()
    store = InMemoryRecipeFeedStore()
    app = create_app()
    _install_dependencies(app, provider, retriever, store)
    inventory = [*_inventory(), {"id": "emoji", "name": "🥦!!!", "quantity": 1}]
    with TestClient(app) as client:
        response = client.post(
            "/api/recipes/sessions",
            headers=_auth_headers(signing_key),
            json={"inventory": inventory},
        )
    assert response.status_code == 200
    assert retriever.calls == ["baby spinach tomatoes"]
    assert "🥦!!!" in provider.prompts[0]
    session = next(iter(store.sessions.values()))
    assert any(item["id"] == "emoji" for item in session.usable_items)


def test_early_exhaustion_is_persisted(signing_key, patch_jwks) -> None:
    patch_jwks([signing_key])
    store = InMemoryRecipeFeedStore()
    app = create_app()
    _install_dependencies(
        app,
        FakeProvider([{"recipes": [_recipe("Dinner")]}, _assessment(1)]),
        StubRetriever(),
        store,
    )
    with TestClient(app) as client:
        first = client.post(
            "/api/recipes/sessions",
            headers=_auth_headers(signing_key),
            json={"inventory": _inventory()},
        )
        session_id = UUID(first.json()["data"]["session_id"])
        store.sessions[session_id] = store.sessions[session_id].model_copy(
            update={"usable_items": []}
        )
        response = client.post(
            f"/api/recipes/sessions/{session_id}/pages",
            headers=_auth_headers(signing_key),
            json={"cursor": "1"},
        )
    assert response.json()["data"]["has_more"] is False
    assert store.sessions[session_id].has_more is False


@pytest.mark.asyncio
async def test_concurrent_refills_share_the_last_generation_run(
    signing_key,
    patch_jwks,
) -> None:
    import asyncio

    import httpx

    patch_jwks([signing_key])

    class SlowProvider(PromptRecordingProvider):
        async def generate(self, *args, **kwargs):
            await asyncio.sleep(0.1)
            return await super().generate(*args, **kwargs)

    store = InMemoryRecipeFeedStore()
    provider = SlowProvider(
        [
                {"recipes": [_recipe("Initial")]},
                _assessment(1),
                {"recipes": [_recipe("Last run")]},
                _assessment(1),
            {"recipes": [_recipe("Over budget")]},
        ]
    )
    app = create_app()
    _install_dependencies(app, provider, StubRetriever(), store)
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as client:
        first = await client.post(
            "/api/recipes/sessions",
            headers=_auth_headers(signing_key),
            json={"inventory": _inventory()},
        )
        session_id = UUID(first.json()["data"]["session_id"])
        store.sessions[session_id] = store.sessions[session_id].model_copy(
            update={"generation_runs": 5}
        )
        pages = await asyncio.gather(
            *[
                client.post(
                    f"/api/recipes/sessions/{session_id}/pages",
                    headers=_auth_headers(signing_key),
                    json={"cursor": "1"},
                )
                for _ in range(2)
            ]
        )
    assert len(
        [prompt for prompt in provider.prompts if prompt.startswith("Create up")]
    ) == 2
    assert all(page.status_code == 200 for page in pages)
    assert pages[0].json() == pages[1].json()
    assert store.sessions[session_id].generation_runs == 6
    assert (
        len(store.items[session_id]) == store.sessions[session_id].candidate_count == 2
    )


def test_failed_refill_can_retry_without_refunding_its_run(signing_key, patch_jwks):
    from app.ai.llm.errors import ProviderError

    patch_jwks([signing_key])
    store = InMemoryRecipeFeedStore()
    provider = FakeProvider(
        [
                {"recipes": [_recipe("Initial")]},
                _assessment(1),
                ProviderError("Unavailable"),
                {"recipes": [_recipe("Retry")]},
                _assessment(1),
        ]
    )
    app = create_app()
    _install_dependencies(app, provider, StubRetriever(), store)
    with TestClient(app) as client:
        first = client.post(
            "/api/recipes/sessions",
            headers=_auth_headers(signing_key),
            json={"inventory": _inventory()},
        )
        session_id = UUID(first.json()["data"]["session_id"])
        failure = client.post(
            f"/api/recipes/sessions/{session_id}/pages",
            headers=_auth_headers(signing_key),
            json={"cursor": "1"},
        )
        assert failure.status_code == 503
        assert store.sessions[session_id].generation_runs == 2
        assert store.sessions[session_id].refill_claim_id is None
        retry = client.post(
            f"/api/recipes/sessions/{session_id}/pages",
            headers=_auth_headers(signing_key),
            json={"cursor": "1"},
        )
    assert retry.status_code == 200
    assert retry.json()["data"]["recipes"][0]["title"] == "Retry"
    assert store.sessions[session_id].generation_runs == 3
