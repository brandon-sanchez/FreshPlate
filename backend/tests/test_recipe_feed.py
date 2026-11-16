"""HTTP-seam tests for the cursor-backed recipe feed."""

from __future__ import annotations

from collections.abc import Sequence
from datetime import date, datetime, timedelta, timezone
from typing import Any
from uuid import UUID

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.ai.agents.kitchen_basics import KitchenBasics
from app.ai.agents.limits import DEFAULT_BATCH_CEILING
from app.ai.llm.errors import ProviderError
from app.ai.llm.providers import FakeProvider
from app.ai.rag.vector_store import RetrievedRecipe
from app.api.images import get_image_service
from app.api.recipes import (
    get_food_line_source,
    get_recipe_feed_store,
    get_recipe_provider,
    get_recipe_retriever,
)
from app.main import create_app
from app.services.food_lines import FoodLinesError
from app.services.image_service import ImageService
from app.services.recipe_feed_store import RecipeFeedSession, RecipeFeedStoreError
from tests.conftest import HOUSEHOLD_ID, FakeFoodLineSource, SigningKey
from tests.image_fakes import POLICY, FakeStore
from tests.image_fakes import FakeProvider as FakeImageProvider
from tests.recipe_fakes import NO_BASICS, batch_responses, model_answer


def _auth_headers(signing_key: SigningKey) -> dict[str, str]:
    return {"Authorization": f"Bearer {signing_key.sign()}"}


def _inventory() -> list[dict[str, Any]]:
    return [
        {
            "id": "spinach",
            "name": "Baby Spinach",
            "available": 1,
            "stock_base": "each",
            "each_label": "bag",
            "next_expiry": (date.today() + timedelta(days=2)).isoformat(),
        },
        {
            "id": "tomatoes",
            "name": "Tomatoes",
            "available": 3,
            "stock_base": "each",
            "each_label": "each",
            "next_expiry": (date.today() + timedelta(days=30)).isoformat(),
        },
    ]


_SALT = {"name": "Salt", "inventory_item_id": None, "use_amount": 1, "unit": "tsp"}


def _recipe(
    title: str,
    *seasonings: dict[str, Any],
    basics: KitchenBasics = NO_BASICS,
) -> dict[str, Any]:
    recipe = {
        "title": title,
        "cook_time_minutes": 20,
        "servings": 2,
        "ingredients": [
            {
                "name": "Baby Spinach",
                "inventory_item_id": "spinach",
                "use_amount": 0.5,
                "unit": "bag",
            },
            *seasonings,
        ],
        "steps": ["Cook the vegetables."],
    }
    return model_answer(recipe, _inventory(), basics)


def _assessment(count: int) -> dict[str, Any]:
    return {
        "checks": [
            {
                "candidate_index": index,
                "main_component": "vegetables",
                "portion_reasoning": "complete meal",
                "unlisted_foods": [],
                "dish_reasoning": "a meal on its own",
                "is_requested_dish": True,
                "realistic_portions": True,
                "coherent_method": True,
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
    inventory: list[dict[str, Any]] | None = None,
    basics: list[str] | None = None,
) -> None:
    foods = FakeFoodLineSource(
        _inventory() if inventory is None else inventory, basics
    )
    app.dependency_overrides[get_food_line_source] = lambda: foods
    app.dependency_overrides[get_recipe_provider] = lambda: provider
    app.dependency_overrides[get_recipe_retriever] = lambda: retriever
    app.dependency_overrides[get_recipe_feed_store] = lambda: store
    _install_images(app, FakeStore())


def test_initial_feed_page_uses_a_five_card_head_batch(
    signing_key: SigningKey,
    patch_jwks,
) -> None:
    patch_jwks([signing_key])
    provider = FakeProvider(
        [
            *batch_responses(*(_recipe(f"Recipe {index}") for index in range(1, 6))),
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
            json={"household_id": HOUSEHOLD_ID, "preferences": {}},
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
            *batch_responses(_recipe("Recipe 1"), invalid_recipe),
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
            json={"household_id": HOUSEHOLD_ID, "preferences": {}},
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
            *batch_responses(invalid_recipe),
            *batch_responses(_recipe("Retry recipe")),
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
            json={"household_id": HOUSEHOLD_ID, "preferences": {}},
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
            *batch_responses(*(_recipe(f"Recipe {index}") for index in range(1, 6))),
            _assessment(5),
            *batch_responses(_recipe("Recipe 9"), invalid_recipe),
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
            json={"household_id": HOUSEHOLD_ID, "preferences": {}},
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


def test_feed_session_is_unavailable_when_the_basics_cannot_be_read(
    signing_key: SigningKey,
    patch_jwks,
) -> None:
    class UnreadableBasics(FakeFoodLineSource):
        async def list_kitchen_basics(self, household_id: Any) -> list[str]:
            raise FoodLinesError("Reading kitchen_basics failed")

    patch_jwks([signing_key])
    store = InMemoryRecipeFeedStore()
    app = create_app()
    _install_dependencies(app, FakeProvider([]), StubRetriever(), store)
    app.dependency_overrides[get_food_line_source] = lambda: UnreadableBasics(
        _inventory()
    )

    with TestClient(app) as client:
        response = client.post(
            "/api/recipes/sessions",
            headers=_auth_headers(signing_key),
            json={"household_id": HOUSEHOLD_ID, "preferences": {}},
        )

    assert response.status_code == 503
    assert response.json()["code"] == "RECIPE_FEED_UNAVAILABLE"
    assert store.sessions == {}


def test_feed_refills_season_with_the_basics_the_session_started_with(
    signing_key: SigningKey,
    patch_jwks,
) -> None:
    patch_jwks([signing_key])
    salted = _recipe(
        "Salted spinach", _SALT, basics=KitchenBasics(["Salt", "Tomatoes"])
    )
    provider = FakeProvider(
        [
            *batch_responses(*(_recipe(f"Recipe {index}") for index in range(1, 6))),
            _assessment(5),
            *batch_responses(salted),
            _assessment(1),
        ]
    )
    store = InMemoryRecipeFeedStore()
    app = create_app()
    _install_dependencies(
        app, provider, StubRetriever(), store, basics=["Salt", "Tomatoes"]
    )

    with TestClient(app) as client:
        first = client.post(
            "/api/recipes/sessions",
            headers=_auth_headers(signing_key),
            json={"household_id": HOUSEHOLD_ID, "preferences": {}},
        )
        session_id = first.json()["data"]["session_id"]
        refill = client.post(
            f"/api/recipes/sessions/{session_id}/pages",
            headers=_auth_headers(signing_key),
            json={"cursor": first.json()["data"]["next_cursor"], "limit": 5},
        )

    assert store.sessions[UUID(session_id)].kitchen_basics == KitchenBasics(["Salt"])
    assert refill.status_code == 200
    [recipe] = refill.json()["data"]["recipes"]
    assert recipe["title"] == "Salted spinach"
    assert recipe["match_percent"] == 100


def test_empty_refill_ends_the_feed_with_honest_exhaustion(
    signing_key: SigningKey,
    patch_jwks,
) -> None:
    """A run that adds zero new unique cards ends the feed (ticket #44)."""
    patch_jwks([signing_key])
    provider = FakeProvider(
        [
            *batch_responses(*(_recipe(f"Recipe {index}") for index in range(1, 6))),
            _assessment(5),
            *batch_responses(),
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
            json={"household_id": HOUSEHOLD_ID, "preferences": {}},
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
            *batch_responses(invalid_recipe),
            *batch_responses(invalid_recipe),
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
            json={"household_id": HOUSEHOLD_ID, "preferences": {}},
        )

    assert response.status_code == 200
    assert response.json()["data"]["recipes"] == []
    assert response.json()["data"]["empty_reason"] == "INVENTORY_UNSUPPORTED"
    assert response.json()["data"]["has_more"] is False
    assert response.json()["data"]["next_cursor"] is None


def test_honest_empty_session_reaches_the_empty_state_without_a_retry(
    signing_key: SigningKey,
    patch_jwks,
) -> None:
    patch_jwks([signing_key])
    provider = FakeProvider(batch_responses())
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
            json={"household_id": HOUSEHOLD_ID, "preferences": {}},
        )

    assert response.status_code == 200
    assert response.json()["data"]["recipes"] == []
    assert response.json()["data"]["empty_reason"] == "INVENTORY_UNSUPPORTED"


def test_a_kitchen_that_only_makes_a_side_dish_reaches_the_empty_state(
    signing_key: SigningKey,
    patch_jwks,
) -> None:
    patch_jwks([signing_key])
    side_dish = {
        "checks": [
            {
                **_assessment(1)["checks"][0],
                "dish_reasoning": "Wilted spinach with tomatoes is a side dish.",
                "is_requested_dish": False,
            }
        ]
    }
    provider = FakeProvider(
        [
            *batch_responses(_recipe("Wilted Spinach and Tomatoes")),
            side_dish,
            *batch_responses(_recipe("Spinach and Tomato Saute")),
            side_dish,
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
            json={"household_id": HOUSEHOLD_ID, "preferences": {"meal": "Dinner"}},
        )

    assert response.status_code == 200
    assert response.json()["data"]["recipes"] == []
    assert response.json()["data"]["empty_reason"] == "INVENTORY_UNSUPPORTED"


def test_session_retrieval_query_leads_with_expiring_items_then_proteins(
    signing_key: SigningKey,
    patch_jwks,
) -> None:
    patch_jwks([signing_key])
    retriever = StubRetriever()
    app = create_app()
    inventory = [{**item, "category": "Produce"} for item in _inventory()] + [
        {
            "id": "salmon",
            "name": "Salmon",
            "available": 400,
            "stock_base": "g",
            "category": "Meat & Seafood",
        },
    ]
    _install_dependencies(
        app,
        FakeProvider(batch_responses()),
        retriever,
        InMemoryRecipeFeedStore(),
        inventory,
    )

    with TestClient(app) as client:
        response = client.post(
            "/api/recipes/sessions",
            headers=_auth_headers(signing_key),
            json={"household_id": HOUSEHOLD_ID, "preferences": {}},
        )

    assert response.status_code == 200
    assert retriever.calls == ["baby spinach salmon tomatoes"]


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
                *batch_responses(
                    *(_recipe(f"Recipe {run * 10 + index}") for index in range(1, 6))
                ),
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
            json={"household_id": HOUSEHOLD_ID, "preferences": {}},
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
    assert len(provider._responses) == 6


def test_feed_pages_from_a_server_owned_pool_before_refilling(
    signing_key: SigningKey,
    patch_jwks,
) -> None:
    patch_jwks([signing_key])
    provider = FakeProvider(
        [
            *batch_responses(*(_recipe(f"Recipe {index}") for index in range(1, 6))),
            _assessment(5),
            *batch_responses(_recipe("Recipe 11"), _recipe("Recipe 12")),
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
            json={"household_id": HOUSEHOLD_ID, "preferences": {"meal": "dinner"}},
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
        thinking: Any = None,
    ) -> Any:
        self.prompts.append(prompt)
        return await self._inner.generate(
            prompt,
            response_model=response_model,
            system_instruction=system_instruction,
            deadline=deadline,
            thinking=thinking,
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
            *batch_responses(*(_recipe(f"Recipe {index}") for index in range(1, 6))),
            _assessment(5),
            *batch_responses(_recipe("Recipe 6")),
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
            json={"household_id": HOUSEHOLD_ID, "preferences": {}},
        )
        session_id = first.json()["data"]["session_id"]
        client.post(
            f"/api/recipes/sessions/{session_id}/pages",
            headers=_auth_headers(signing_key),
            json={"cursor": "5", "limit": 5},
        )

    generation_prompts = [
        prompt for prompt in provider.prompts if prompt.startswith("Suggest one meal")
    ]
    assert len(generation_prompts) == 10
    initial_prompt, refill_prompt = generation_prompts[0], generation_prompts[5]
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
        [*batch_responses(_recipe("Private recipe")), _assessment(1)]
    )
    _install_dependencies(app, provider, StubRetriever(), InMemoryRecipeFeedStore())
    with TestClient(app) as client:
        first = client.post(
            "/api/recipes/sessions",
            headers=_auth_headers(signing_key),
            json={"household_id": HOUSEHOLD_ID},
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
        [*batch_responses(_recipe("Spinach dinner")), _assessment(1)]
    )
    retriever = StubRetriever()
    store = InMemoryRecipeFeedStore()
    app = create_app()
    inventory = [
        *_inventory(),
        {"id": "emoji", "name": "🥦!!!", "available": 1, "stock_base": "g"},
    ]
    _install_dependencies(app, provider, retriever, store, inventory)
    with TestClient(app) as client:
        response = client.post(
            "/api/recipes/sessions",
            headers=_auth_headers(signing_key),
            json={"household_id": HOUSEHOLD_ID},
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
        FakeProvider([*batch_responses(_recipe("Dinner")), _assessment(1)]),
        StubRetriever(),
        store,
    )
    with TestClient(app) as client:
        first = client.post(
            "/api/recipes/sessions",
            headers=_auth_headers(signing_key),
            json={"household_id": HOUSEHOLD_ID},
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
            *batch_responses(_recipe("Initial")),
            _assessment(1),
            *batch_responses(_recipe("Last run")),
            _assessment(1),
            *batch_responses(_recipe("Over budget")),
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
            json={"household_id": HOUSEHOLD_ID},
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
    assert (
        len(
            [
                prompt
                for prompt in provider.prompts
                if prompt.startswith("Suggest one meal")
            ]
        )
        == 10
    )
    assert all(page.status_code == 200 for page in pages)
    assert _without_photo_expiry(pages[0].json()) == _without_photo_expiry(
        pages[1].json()
    )
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
            *batch_responses(_recipe("Initial")),
            _assessment(1),
            *[ProviderError("Unavailable")] * 5,
            *batch_responses(_recipe("Retry")),
            _assessment(1),
        ]
    )
    app = create_app()
    _install_dependencies(app, provider, StubRetriever(), store)
    with TestClient(app) as client:
        first = client.post(
            "/api/recipes/sessions",
            headers=_auth_headers(signing_key),
            json={"household_id": HOUSEHOLD_ID},
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


def _without_photo_expiry(body: dict[str, Any]) -> dict[str, Any]:
    for card in body["data"]["recipes"]:
        card["image"].pop("expires_at")
    return body


def _forget_stored_photo(images: FakeStore, card: dict[str, Any]) -> None:
    images.assets.pop(("recipe", card["image"]["image_key"]))


def _install_images(app: FastAPI, store: FakeStore, provider: Any = None) -> None:
    policy = POLICY.model_copy(
        update={"monthly_cap_microusd": 10_000, "user_monthly_cap_microusd": 10_000}
    )
    images = ImageService(store, provider or FakeImageProvider(), policy)
    app.dependency_overrides[get_image_service] = lambda: images


def test_feed_cards_arrive_with_their_photos(signing_key, patch_jwks) -> None:
    patch_jwks([signing_key])
    provider = FakeProvider(
        [
            *batch_responses(_recipe("Recipe 1"), _recipe("Recipe 2")),
            _assessment(2),
            *batch_responses(_recipe("Recipe 3")),
            _assessment(1),
        ]
    )
    feed = InMemoryRecipeFeedStore()
    images = FakeStore()
    app = create_app()
    _install_dependencies(app, provider, StubRetriever(), feed)
    _install_images(app, images)

    with TestClient(app) as client:
        first = client.post(
            "/api/recipes/sessions",
            headers=_auth_headers(signing_key),
            json={"household_id": HOUSEHOLD_ID, "preferences": {}},
        )
        session_id = first.json()["data"]["session_id"]
        refill = client.post(
            f"/api/recipes/sessions/{session_id}/pages",
            headers=_auth_headers(signing_key),
            json={"cursor": "2", "limit": 5},
        )

    cards = first.json()["data"]["recipes"] + refill.json()["data"]["recipes"]
    assert [card["title"] for card in cards] == ["Recipe 1", "Recipe 2", "Recipe 3"]
    assert {card["image"]["status"] for card in cards} == {"ready"}
    assert all(card["image"]["url"].startswith("https://cdn.test/") for card in cards)
    assert len(images.files) == 3
    stored = feed.items[UUID(session_id)]
    assert all("image" not in recipe.model_dump() for recipe in stored)


def test_a_failed_photo_never_fails_the_feed(signing_key, patch_jwks) -> None:
    patch_jwks([signing_key])
    provider = FakeProvider([*batch_responses(_recipe("Recipe 1")), _assessment(1)])
    app = create_app()
    _install_dependencies(app, provider, StubRetriever(), InMemoryRecipeFeedStore())
    failing = FakeImageProvider(ProviderError("down", status_code=500))
    _install_images(app, FakeStore(), failing)

    with TestClient(app) as client:
        response = client.post(
            "/api/recipes/sessions",
            headers=_auth_headers(signing_key),
            json={"household_id": HOUSEHOLD_ID, "preferences": {}},
        )

    assert response.status_code == 200
    [card] = response.json()["data"]["recipes"]
    assert card["image"]["status"] == "unavailable"
    assert card["image"]["reason"] == "failed"


def test_stored_pages_reuse_cached_photos_and_never_generate(
    signing_key, patch_jwks
) -> None:
    patch_jwks([signing_key])
    provider = FakeProvider(
        [*batch_responses(_recipe("Recipe 1"), _recipe("Recipe 2")), _assessment(2)]
    )
    images = FakeStore()
    image_provider = FakeImageProvider()
    app = create_app()
    _install_dependencies(app, provider, StubRetriever(), InMemoryRecipeFeedStore())
    _install_images(app, images, image_provider)

    with TestClient(app) as client:
        first = client.post(
            "/api/recipes/sessions",
            headers=_auth_headers(signing_key),
            json={"household_id": HOUSEHOLD_ID, "preferences": {}},
        )
        session_id = first.json()["data"]["session_id"]
        _forget_stored_photo(images, first.json()["data"]["recipes"][0])
        again = client.post(
            f"/api/recipes/sessions/{session_id}/pages",
            headers=_auth_headers(signing_key),
            json={"cursor": "0", "limit": 2},
        )

    cards = again.json()["data"]["recipes"]
    assert [card["image"] and card["image"]["status"] for card in cards] == [
        None,
        "ready",
    ]
    assert len(image_provider.prompts) == 2


def _steering_session(
    signing_key: SigningKey, refill: list[dict[str, Any]]
) -> tuple[PromptRecordingProvider, FastAPI]:
    titles = ["Spinach Frittata", "Spinach Soup", "Tomato Salad"]
    provider = PromptRecordingProvider(
        [
            *batch_responses(*(_recipe(title) for title in titles)),
            _assessment(3),
            *batch_responses(*refill),
            _assessment(len(refill)),
        ]
    )
    app = create_app()
    _install_dependencies(app, provider, StubRetriever(), InMemoryRecipeFeedStore())
    return provider, app


def _refill_prompt(provider: PromptRecordingProvider) -> str:
    return [
        prompt for prompt in provider.prompts if prompt.startswith("Suggest one meal")
    ][-1]


def test_steered_refill_asks_for_more_and_fewer_recipes_like_the_chosen_cards(
    signing_key: SigningKey,
    patch_jwks,
) -> None:
    patch_jwks([signing_key])
    provider, app = _steering_session(signing_key, [_recipe("Spinach Pie")])

    with TestClient(app) as client:
        first = client.post(
            "/api/recipes/sessions",
            headers=_auth_headers(signing_key),
            json={"household_id": HOUSEHOLD_ID, "preferences": {}},
        )
        data = first.json()["data"]
        ids = {card["title"]: card["recipe_id"] for card in data["recipes"]}
        page = client.post(
            f"/api/recipes/sessions/{data['session_id']}/pages",
            headers=_auth_headers(signing_key),
            json={
                "cursor": "3",
                "limit": 5,
                "steering": {
                    "more_like": [ids["Spinach Frittata"]],
                    "less_like": [
                        ids["Tomato Salad"],
                        "00000000-0000-4000-8000-000000000000",
                    ],
                },
            },
        )

    assert page.status_code == 200
    assert [card["title"] for card in page.json()["data"]["recipes"]] == [
        "Spinach Pie"
    ]
    steering = (
        _refill_prompt(provider)
        .split("Steering from the cook")[1]
        .split("Direction for this recipe")[0]
    )
    more, _, less = steering.partition("fewer recipes like these")
    assert "- Spinach Frittata (uses Baby Spinach)" in more
    assert "- Tomato Salad (uses Baby Spinach)" in less
    assert "Spinach Soup" not in steering
    assert "share at least two foods" in steering
    refill_calls = [
        prompt for prompt in provider.prompts if prompt.startswith("Suggest one meal")
    ][DEFAULT_BATCH_CEILING:]
    assert len(refill_calls) == DEFAULT_BATCH_CEILING
    assert all("Steering from the cook" in prompt for prompt in refill_calls)


def test_unsteered_refill_prompt_has_no_steering(
    signing_key: SigningKey,
    patch_jwks,
) -> None:
    patch_jwks([signing_key])
    provider, app = _steering_session(signing_key, [_recipe("Spinach Pie")])

    with TestClient(app) as client:
        first = client.post(
            "/api/recipes/sessions",
            headers=_auth_headers(signing_key),
            json={"household_id": HOUSEHOLD_ID, "preferences": {}},
        )
        client.post(
            f"/api/recipes/sessions/{first.json()['data']['session_id']}/pages",
            headers=_auth_headers(signing_key),
            json={"cursor": "3", "limit": 5},
        )

    assert "recipes like these" not in _refill_prompt(provider)


def _uuid(n: int) -> str:
    return f"00000000-0000-4000-8000-{n:012d}"


@pytest.mark.parametrize(
    "steering",
    [
        {"more_like": [_uuid(n) for n in range(4)]},
        {"less_like": [_uuid(n) for n in range(11)]},
        {"more_like": [], "less_like": [], "extra": []},
        {"more_like": ["not-a-uuid"]},
    ],
)
def test_page_request_rejects_malformed_steering(
    signing_key: SigningKey,
    patch_jwks,
    steering: dict[str, Any],
) -> None:
    patch_jwks([signing_key])
    app = create_app()
    _install_dependencies(
        app, FakeProvider([]), StubRetriever(), InMemoryRecipeFeedStore()
    )

    with TestClient(app) as client:
        response = client.post(
            "/api/recipes/sessions/00000000-0000-4000-8000-000000000000/pages",
            headers=_auth_headers(signing_key),
            json={"cursor": "0", "limit": 5, "steering": steering},
        )

    assert response.status_code == 422


@pytest.mark.parametrize(
    ("preferences", "dish"),
    [({}, "meal"), ({"meal": "Snack"}, "snack"), ({"meal": "Dessert"}, "dessert")],
)
def test_an_empty_session_names_the_dish_the_cook_asked_for(
    signing_key: SigningKey,
    patch_jwks,
    preferences: dict[str, str],
    dish: str,
) -> None:
    patch_jwks([signing_key])
    app = create_app()
    _install_dependencies(
        app,
        FakeProvider(batch_responses()),
        StubRetriever(),
        InMemoryRecipeFeedStore(),
    )

    with TestClient(app) as client:
        response = client.post(
            "/api/recipes/sessions",
            headers=_auth_headers(signing_key),
            json={"household_id": HOUSEHOLD_ID, "preferences": preferences},
        )

    assert response.status_code == 200
    assert response.json()["data"]["empty_reason"] == "INVENTORY_UNSUPPORTED"
    assert response.json()["data"]["requested_dish"] == dish
