from __future__ import annotations

import asyncio
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.ai.llm.errors import ProviderError
from app.api.recipes import (
    RECIPE_FEED_INITIAL_HEAD_BATCH_CEILING,
    RECIPE_FEED_REFILL_BATCH_CEILING,
    get_food_line_source,
    get_recipe_feed_store,
    get_recipe_provider,
    get_recipe_retriever,
)
from app.core.config import settings
from app.main import create_app
from tests.conftest import HOUSEHOLD_ID, FakeFoodLineSource
from tests.recipe_fakes import (
    NO_BASICS,
    MealFakeProvider,
    batch_responses,
    model_answer,
)


def _inventory() -> list[dict[str, Any]]:
    return [
        {"id": "itm-01", "name": "Chicken breast", "available": 900, "stock_base": "g"},
        {"id": "itm-02", "name": "Rice", "available": 450, "stock_base": "g"},
    ]


def _recipe(title: str) -> dict[str, Any]:
    recipe = {
        "title": title,
        "description": "Test recipe",
        "servings": 2,
        "total_minutes": 30,
        "steps": ["Cook."],
        "ingredients": [
            {
                "name": "Chicken breast",
                "inventory_item_id": "itm-01",
                "use_amount": 1,
                "unit": "lb",
            }
        ],
    }
    return model_answer(recipe, _inventory(), NO_BASICS)


class StubRetriever:
    async def search(self, query, *, limit, match_threshold, deadline):
        return []


class RateLimitedProvider:
    """What GeminiProvider surfaces after its 429 retries are exhausted."""

    async def generate(
        self,
        prompt,
        *,
        response_model,
        system_instruction=None,
        deadline=None,
        thinking=None,
    ):
        raise ProviderError(
            "Gemini generation failed",
            status_code=429,
            retry_after_seconds=30.0,
        )


class SlowZeroValidProvider:
    """First generation is fully rejected; every call burns real time.

    Mirrors the quality-retry worst case that used to 503: generation one
    finishes late in the budget, so a retry could only time out or trip
    Gemini's 10-second minimum HTTP deadline.
    """

    def __init__(self, delay_seconds: float) -> None:
        self._delay_seconds = delay_seconds
        self.calls = 0

    async def generate(
        self,
        prompt,
        *,
        response_model,
        system_instruction=None,
        deadline=None,
        thinking=None,
    ):
        self.calls += 1
        await asyncio.sleep(self._delay_seconds)
        rejected = {
            "title": "Untracked chicken",
            "cook_time_minutes": 30,
            "servings": 2,
            "steps": ["Cook."],
            "ingredients": [
                {
                    "name": "Chicken breast",
                    "inventory_item_id": "not-in-inventory",
                    "use_amount": 1,
                    "unit": "lb",
                }
            ],
        }
        return response_model.model_validate({"recipes": [rejected]})


class UnusedStore:
    async def create_session(self, session, *, recipes=()):
        raise AssertionError("store should not be reached")

    async def get_session(self, user_id, session_id):
        raise AssertionError("store should not be reached")

    async def list_candidates(self, user_id, session_id, *, start_position, limit):
        raise AssertionError("store should not be reached")

    async def append_candidates(self, user_id, session_id, *, start_position, recipes):
        raise AssertionError("store should not be reached")

    async def update_session(self, user_id, session_id, **kwargs):
        raise AssertionError("store should not be reached")


def _client(provider: Any) -> TestClient:
    app = create_app()
    app.dependency_overrides[get_recipe_provider] = lambda: provider
    app.dependency_overrides[get_recipe_retriever] = StubRetriever
    app.dependency_overrides[get_recipe_feed_store] = UnusedStore
    app.dependency_overrides[get_food_line_source] = lambda: FakeFoodLineSource(
        _inventory()
    )
    return TestClient(app)


def _post_session(client: TestClient, signing_key) -> Any:
    return client.post(
        "/api/recipes/sessions",
        headers={"Authorization": f"Bearer {signing_key.sign()}"},
        json={"household_id": HOUSEHOLD_ID, "preferences": {}},
    )


def test_rate_limited_provider_surfaces_as_loader_error(
    signing_key,
    patch_jwks,
) -> None:
    """Free-tier mechanism: sustained 429 -> ProviderError -> 503 AI_UNAVAILABLE.

    The mobile client maps any non-200 session response to the post-loader
    error-with-retry state, so this response IS the reported symptom.
    """
    patch_jwks([signing_key])
    with _client(RateLimitedProvider()) as client:
        response = _post_session(client, signing_key)

    assert response.status_code == 503
    assert response.json()["code"] == "AI_UNAVAILABLE"


def test_zero_valid_generation_late_in_budget_skips_the_quality_retry(
    signing_key,
    patch_jwks,
    monkeypatch,
) -> None:
    patch_jwks([signing_key])
    from tests.test_recipe_feed import InMemoryRecipeFeedStore

    monkeypatch.setattr(settings, "recipe_feed_initial_budget_seconds", 0.6)
    provider = SlowZeroValidProvider(delay_seconds=0.4)
    app = create_app()
    app.dependency_overrides[get_recipe_provider] = lambda: provider
    app.dependency_overrides[get_recipe_retriever] = StubRetriever
    app.dependency_overrides[get_recipe_feed_store] = InMemoryRecipeFeedStore
    app.dependency_overrides[get_food_line_source] = lambda: FakeFoodLineSource(
        _inventory()
    )
    with TestClient(app) as client:
        response = _post_session(client, signing_key)

    assert provider.calls == RECIPE_FEED_INITIAL_HEAD_BATCH_CEILING
    assert response.status_code == 200
    assert response.json()["data"]["recipes"] == []
    assert response.json()["data"]["empty_reason"] == "INVENTORY_UNSUPPORTED"
    assert response.json()["data"]["has_more"] is False


@pytest.mark.asyncio
@pytest.mark.parametrize("cancel_request", [False, True])
async def test_refill_deadline_observes_provider_failure_during_cancellation(
    signing_key,
    patch_jwks,
    monkeypatch,
    cancel_request,
) -> None:
    import gc
    from types import SimpleNamespace

    import httpx

    from app.ai.agents.photos import PHOTO_RESERVE_SECONDS
    from app.ai.llm.providers import GeminiProvider
    from tests.test_recipe_feed import (
        InMemoryRecipeFeedStore,
        StubRetriever,
        _auth_headers,
        _install_dependencies,
        _recipe,
    )

    class ReadTimeoutDuringCleanup:
        calls = 0

        def __init__(self):
            self.all_started = asyncio.Event()

        async def generate_content(self, **kwargs):
            self.calls += 1
            if self.calls == RECIPE_FEED_REFILL_BATCH_CEILING:
                self.all_started.set()
            try:
                await asyncio.Event().wait()
            except asyncio.CancelledError as exc:
                raise httpx.ReadTimeout(
                    "Read timed out while the request ended"
                ) from exc

    patch_jwks([signing_key])
    generation_budget = 0.03
    monkeypatch.setattr(
        settings,
        "recipe_feed_page_budget_seconds",
        25 if cancel_request else PHOTO_RESERVE_SECONDS + generation_budget,
    )
    monkeypatch.setattr("app.ai.llm.providers.GEMINI_MIN_DEADLINE_SECONDS", 0)
    store = InMemoryRecipeFeedStore()
    app = create_app()
    _install_dependencies(
        app,
        MealFakeProvider(batch_responses(_recipe("Initial"))),
        StubRetriever(),
        store,
    )
    models = ReadTimeoutDuringCleanup()
    provider = GeminiProvider(
        api_key="test",
        client=SimpleNamespace(aio=SimpleNamespace(models=models)),
    )
    loop = asyncio.get_running_loop()
    unobserved = []
    previous = loop.get_exception_handler()
    loop.set_exception_handler(lambda loop, context: unobserved.append(context))
    try:
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app),
            base_url="http://test",
        ) as client:
            first = await client.post(
                "/api/recipes/sessions",
                headers=_auth_headers(signing_key),
                json={"household_id": HOUSEHOLD_ID},
            )
            assert first.status_code == 200
            app.dependency_overrides[get_recipe_provider] = lambda: provider
            session_id = first.json()["data"]["session_id"]
            request = asyncio.create_task(
                client.post(
                    f"/api/recipes/sessions/{session_id}/pages",
                    headers=_auth_headers(signing_key),
                    json={"cursor": "1"},
                )
            )
            if cancel_request:
                await models.all_started.wait()
                request.cancel()
                with pytest.raises(asyncio.CancelledError):
                    await request
            else:
                response = await request
                assert response.status_code == 503
                assert response.json()["code"] == "AI_UNAVAILABLE"
        assert models.calls == RECIPE_FEED_REFILL_BATCH_CEILING
        gc.collect()
        await asyncio.sleep(0)
        assert unobserved == []
    finally:
        loop.set_exception_handler(previous)
