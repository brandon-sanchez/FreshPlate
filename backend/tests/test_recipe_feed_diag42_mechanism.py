"""Deterministic mechanism repros for the intermittent post-loader error (#42).

Offline companions to test_recipe_feed_live_repro.py. Each test replays one
suspected failure mechanism through the real session endpoint and asserts the
exact surface the mobile client turns into the error-with-retry state.
"""

from __future__ import annotations

import asyncio
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.ai.llm.errors import ProviderError
from app.api.recipes import (
    get_recipe_feed_store,
    get_recipe_provider,
    get_recipe_retriever,
)
from app.core.config import settings
from app.main import create_app


def _inventory() -> list[dict[str, Any]]:
    return [
        {"id": "itm-01", "name": "Chicken breast", "quantity": 2, "unit": "lb"},
        {"id": "itm-02", "name": "Rice", "quantity": 1, "unit": "lb"},
    ]


def _recipe(title: str) -> dict[str, Any]:
    return {
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


class StubRetriever:
    async def search(self, query, *, limit, match_threshold, deadline):
        return []


class RateLimitedProvider:
    """What GeminiProvider surfaces after its 429 retries are exhausted."""

    async def generate(
        self, prompt, *, response_model, system_instruction=None, deadline=None
    ):
        raise ProviderError(
            "Gemini generation failed",
            status_code=429,
            retry_after_seconds=30.0,
        )


class SlowZeroValidProvider:
    """First generation returns nothing valid; every call burns real time.

    Mirrors the quality-retry worst case that used to 503: generation one
    finishes late in the budget, so a retry could only time out or trip
    Gemini's 10-second minimum HTTP deadline.
    """

    def __init__(self, delay_seconds: float) -> None:
        self._delay_seconds = delay_seconds
        self.calls = 0

    async def generate(
        self, prompt, *, response_model, system_instruction=None, deadline=None
    ):
        self.calls += 1
        await asyncio.sleep(self._delay_seconds)
        return response_model.model_validate({"recipes": []})


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
    return TestClient(app)


def _post_session(client: TestClient, signing_key) -> Any:
    return client.post(
        "/api/recipes/sessions",
        headers={"Authorization": f"Bearer {signing_key.sign()}"},
        json={"inventory": _inventory(), "preferences": {}},
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
    """Regression for the #42 fix: no retry without one generation's budget.

    Before the fix this scenario fired a second generation with almost no
    time left and surfaced as 503 AI_UNAVAILABLE. Now the router skips the
    quality retry below its 20-second floor and the loader ends in the
    explicit empty state instead of the error state.
    """
    patch_jwks([signing_key])
    from tests.test_recipe_feed import InMemoryRecipeFeedStore

    monkeypatch.setattr(settings, "recipe_feed_initial_budget_seconds", 0.6)
    provider = SlowZeroValidProvider(delay_seconds=0.4)
    app = create_app()
    app.dependency_overrides[get_recipe_provider] = lambda: provider
    app.dependency_overrides[get_recipe_retriever] = StubRetriever
    app.dependency_overrides[get_recipe_feed_store] = InMemoryRecipeFeedStore
    with TestClient(app) as client:
        response = _post_session(client, signing_key)

    assert provider.calls == 1
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

    from app.ai.llm.providers import FakeProvider, GeminiProvider
    from tests.test_recipe_feed import (
        InMemoryRecipeFeedStore,
        StubRetriever,
        _auth_headers,
        _install_dependencies,
        _inventory,
        _recipe,
    )

    class ReadTimeoutDuringCleanup:
        calls = 0

        def __init__(self):
            self.started = asyncio.Event()

        async def generate_content(self, **kwargs):
            self.calls += 1
            self.started.set()
            try:
                await asyncio.Event().wait()
            except asyncio.CancelledError as exc:
                raise httpx.ReadTimeout(
                    "Read timed out while the request ended"
                ) from exc

    patch_jwks([signing_key])
    monkeypatch.setattr(
        settings, "recipe_feed_page_budget_seconds", 25 if cancel_request else 0.03
    )
    monkeypatch.setattr("app.ai.llm.providers.GEMINI_MIN_DEADLINE_SECONDS", 0)
    store = InMemoryRecipeFeedStore()
    app = create_app()
    _install_dependencies(
        app,
        FakeProvider(
            [
                {"recipes": [_recipe("Initial")]},
                {
                    "decisions": [
                        {
                            "candidate_index": 0,
                            "verdict": "eligible",
                            "reason": "complete meal",
                        }
                    ]
                },
            ]
        ),
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
                json={"inventory": _inventory()},
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
                await models.started.wait()
                request.cancel()
                with pytest.raises(asyncio.CancelledError):
                    await request
            else:
                response = await request
                assert response.status_code == 503
                assert response.json()["code"] == "AI_UNAVAILABLE"
        assert models.calls == 1
        gc.collect()
        await asyncio.sleep(0)
        assert unobserved == []
    finally:
        loop.set_exception_handler(previous)
