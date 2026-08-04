"""HTTP-seam tests for the authenticated recipe suggestion endpoint."""

from __future__ import annotations

import asyncio
import time
from datetime import date, timedelta
from typing import Any
from uuid import UUID

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.ai.agents.models import Recipe, RecipeGenerationResponse
from app.ai.eval.scorers import ingredient_coverage_percent
from app.ai.llm.errors import ProviderError
from app.ai.llm.providers import FakeProvider
from app.ai.rag.vector_store import RetrievedRecipe
from app.api.recipes import get_recipe_provider, get_recipe_retriever
from app.main import create_app
from tests.conftest import SigningKey


def _auth_headers(signing_key: SigningKey) -> dict[str, str]:
    return {"Authorization": f"Bearer {signing_key.sign()}"}


def _inventory(*, expiring: bool = True) -> list[dict[str, Any]]:
    expiration_date = (
        date.today() + timedelta(days=2)
        if expiring
        else date.today() + timedelta(days=30)
    )
    return [
        {
            "id": "spinach",
            "name": "Baby Spinach",
            "quantity": 1,
            "unit": "bag",
            "expiration_date": expiration_date.isoformat(),
        },
        {
            "id": "tomatoes",
            "name": "Tomatoes",
            "quantity": 3,
            "unit": "item",
            "expiration_date": (date.today() + timedelta(days=30)).isoformat(),
        },
    ]


def _recipe(title: str = "Spinach Pasta") -> dict[str, Any]:
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
            },
            {
                "name": "Tomatoes",
                "inventory_item_id": "tomatoes",
                "use_amount": 1,
                "unit": "item",
            },
        ],
        "steps": ["Cook the vegetables.", "Toss with pasta."],
    }


class StubRetriever:
    async def search(self, query: str, **_: Any) -> list[RetrievedRecipe]:
        assert query == "baby spinach tomatoes"
        return [
            RetrievedRecipe(
                id=101,
                title="Spinach Pasta Inspiration",
                content="Cook spinach and tomatoes with pasta.",
                similarity=0.9,
            )
        ]


def _install_graph_dependencies(
    app: FastAPI,
    provider: Any,
    retriever: Any | None = None,
) -> None:
    app.dependency_overrides[get_recipe_provider] = lambda: provider
    app.dependency_overrides[get_recipe_retriever] = (
        lambda: retriever or StubRetriever()
    )


@pytest.fixture
def recipe_app() -> FastAPI:
    return create_app()


def test_authenticated_suggestion_returns_identity_match_and_expiry_badge(
    recipe_app: FastAPI,
    signing_key: SigningKey,
    patch_jwks,
) -> None:
    patch_jwks([signing_key])
    _install_graph_dependencies(
        recipe_app,
        FakeProvider([{"recipes": [_recipe()]}]),
    )

    with TestClient(recipe_app) as client:
        response = client.post(
            "/api/recipes/suggestions",
            headers=_auth_headers(signing_key),
            json={
                "inventory": _inventory(),
                "preferences": {"meal": "dinner"},
                "exclude_titles": [],
                "batch_ceiling": 5,
            },
        )

    assert response.status_code == 200
    body = response.json()
    assert len(body["data"]["recipes"]) == 1
    suggestion = body["data"]["recipes"][0]
    UUID(suggestion["recipe_id"])
    assert suggestion["title"] == "Spinach Pasta"
    assert suggestion["match_percent"] == 100
    assert suggestion["saves_expiring"] == ["Baby Spinach"]


def test_same_title_regeneration_gets_a_new_recipe_id(
    recipe_app: FastAPI,
    signing_key: SigningKey,
    patch_jwks,
) -> None:
    patch_jwks([signing_key])
    recipe_app.dependency_overrides[get_recipe_provider] = lambda: FakeProvider(
        [{"recipes": [_recipe()]}]
    )
    recipe_app.dependency_overrides[get_recipe_retriever] = lambda: StubRetriever()

    with TestClient(recipe_app) as client:
        first = client.post(
            "/api/recipes/suggestions",
            headers=_auth_headers(signing_key),
            json={"inventory": _inventory()},
        )
        second = client.post(
            "/api/recipes/suggestions",
            headers=_auth_headers(signing_key),
            json={"inventory": _inventory()},
        )

    assert first.status_code == 200
    assert second.status_code == 200
    first_id = first.json()["data"]["recipes"][0]["recipe_id"]
    second_id = second.json()["data"]["recipes"][0]["recipe_id"]
    assert first_id != second_id


def test_ingredient_coverage_counts_untracked_staples_in_denominator() -> None:
    recipe = Recipe.model_validate(
        {
            **_recipe(),
            "ingredients": [
                *_recipe()["ingredients"],
                {
                    "name": "Salt",
                    "inventory_item_id": None,
                    "use_amount": 1,
                    "unit": "pinch",
                },
            ],
        }
    )

    assert ingredient_coverage_percent(recipe, _inventory()) == 67


def test_suggestion_honors_exclusions_and_batch_ceiling(
    recipe_app: FastAPI,
    signing_key: SigningKey,
    patch_jwks,
) -> None:
    patch_jwks([signing_key])
    provider = FakeProvider(
        [
            {
                "recipes": [
                    _recipe("First Recipe"),
                    _recipe("Excluded Recipe"),
                    _recipe("Third Recipe"),
                ]
            }
        ]
    )
    _install_graph_dependencies(recipe_app, provider)

    with TestClient(recipe_app) as client:
        response = client.post(
            "/api/recipes/suggestions",
            headers=_auth_headers(signing_key),
            json={
                "inventory": _inventory(expiring=False),
                "exclude_titles": [" excluded   recipe "],
                "batch_ceiling": 2,
            },
        )

    assert response.status_code == 200
    titles = [recipe["title"] for recipe in response.json()["data"]["recipes"]]
    assert titles == ["First Recipe"]


def test_suggestion_rejects_invalid_request_with_422(
    recipe_app: FastAPI,
    signing_key: SigningKey,
    patch_jwks,
) -> None:
    patch_jwks([signing_key])

    with TestClient(recipe_app) as client:
        response = client.post(
            "/api/recipes/suggestions",
            headers=_auth_headers(signing_key),
            json={"inventory": [], "batch_ceiling": -1},
        )

    assert response.status_code == 422


def test_suggestion_rejects_a_batch_ceiling_above_the_server_limit(
    recipe_app: FastAPI,
    signing_key: SigningKey,
    patch_jwks,
) -> None:
    patch_jwks([signing_key])

    with TestClient(recipe_app) as client:
        response = client.post(
            "/api/recipes/suggestions",
            headers=_auth_headers(signing_key),
            json={"inventory": [], "batch_ceiling": 11},
        )

    assert response.status_code == 422


def test_suggestion_requires_authentication(recipe_app: FastAPI) -> None:
    with TestClient(recipe_app) as client:
        response = client.post(
            "/api/recipes/suggestions",
            json={"inventory": []},
        )

    assert response.status_code == 401
    assert response.json()["code"] == "AUTH_MISSING_TOKEN"


def test_provider_failure_returns_ai_unavailable(
    recipe_app: FastAPI,
    signing_key: SigningKey,
    patch_jwks,
) -> None:
    patch_jwks([signing_key])
    _install_graph_dependencies(
        recipe_app,
        FakeProvider([ProviderError("provider unavailable")]),
    )

    with TestClient(recipe_app) as client:
        response = client.post(
            "/api/recipes/suggestions",
            headers=_auth_headers(signing_key),
            json={"inventory": _inventory()},
        )

    assert response.status_code == 503
    assert response.json() == {
        "error": "AI service unavailable",
        "code": "AI_UNAVAILABLE",
    }


class DelayedProvider:
    def __init__(self, delay_seconds: float) -> None:
        self.delay_seconds = delay_seconds

    async def generate(
        self,
        _prompt: str,
        *,
        response_model: type[RecipeGenerationResponse],
        system_instruction: str | None,
        deadline: Any,
    ) -> RecipeGenerationResponse:
        del response_model, system_instruction, deadline
        await asyncio.sleep(self.delay_seconds)
        return RecipeGenerationResponse(recipes=[_recipe()])


def test_deadline_exhaustion_returns_ai_unavailable(
    recipe_app: FastAPI,
    signing_key: SigningKey,
    patch_jwks,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    patch_jwks([signing_key])
    monkeypatch.setattr(
        "app.api.recipes.settings.ai_pipeline_budget_seconds",
        0.03,
    )
    _install_graph_dependencies(recipe_app, DelayedProvider(0.2))

    with TestClient(recipe_app) as client:
        response = client.post(
            "/api/recipes/suggestions",
            headers=_auth_headers(signing_key),
            json={"inventory": _inventory()},
        )

    assert response.status_code == 503
    assert response.json()["code"] == "AI_UNAVAILABLE"


def test_deadline_starts_when_a_delayed_request_enters_the_server(
    recipe_app: FastAPI,
    signing_key: SigningKey,
    patch_jwks,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    patch_jwks([signing_key])
    monkeypatch.setattr(
        "app.api.recipes.settings.ai_pipeline_budget_seconds",
        0.08,
    )
    _install_graph_dependencies(recipe_app, DelayedProvider(0.01))
    time.sleep(0.1)

    with TestClient(recipe_app) as client:
        response = client.post(
            "/api/recipes/suggestions",
            headers=_auth_headers(signing_key),
            json={"inventory": _inventory()},
        )

    assert response.status_code == 200
