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
from app.api.recipes import (
    get_food_line_source,
    get_recipe_provider,
    get_recipe_retriever,
)
from app.main import create_app
from app.services.food_lines import FoodLinesError
from tests.conftest import HOUSEHOLD_ID, FakeFoodLineSource, SigningKey


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
            "available": 1,
            "stock_base": "each",
            "each_label": "bag",
            "next_expiry": expiration_date.isoformat(),
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


def _eligible(index: int = 0) -> dict[str, Any]:
    return {
        "candidate_index": index,
        "main_component": "pasta",
        "portion_reasoning": "complete meal",
        "unlisted_foods": [],
        "is_full_meal": True,
        "realistic_portions": True,
        "coherent_method": True,
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
    *,
    foods: FakeFoodLineSource | None = None,
) -> None:
    source = foods or FakeFoodLineSource(_inventory())
    app.dependency_overrides[get_food_line_source] = lambda: source
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
        FakeProvider(
            [
                {"recipes": [_recipe()]},
                {
                    "checks": [_eligible()]
                },
            ]
        ),
    )

    with TestClient(recipe_app) as client:
        response = client.post(
            "/api/recipes/suggestions",
            headers=_auth_headers(signing_key),
            json={
                "household_id": HOUSEHOLD_ID,
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
    _install_graph_dependencies(recipe_app, None)
    recipe_app.dependency_overrides[get_recipe_provider] = lambda: FakeProvider(
        [
            {"recipes": [_recipe()]},
            {
                "checks": [_eligible()]
            },
        ]
    )

    with TestClient(recipe_app) as client:
        first = client.post(
            "/api/recipes/suggestions",
            headers=_auth_headers(signing_key),
            json={"household_id": HOUSEHOLD_ID},
        )
        second = client.post(
            "/api/recipes/suggestions",
            headers=_auth_headers(signing_key),
            json={"household_id": HOUSEHOLD_ID},
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
            },
            {"checks": [
                _eligible(),
                _eligible(1),
            ]},
        ]
    )
    _install_graph_dependencies(
        recipe_app, provider, foods=FakeFoodLineSource(_inventory(expiring=False))
    )

    with TestClient(recipe_app) as client:
        response = client.post(
            "/api/recipes/suggestions",
            headers=_auth_headers(signing_key),
            json={
                "household_id": HOUSEHOLD_ID,
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
            json={"household_id": HOUSEHOLD_ID, "batch_ceiling": -1},
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
            json={"household_id": HOUSEHOLD_ID, "batch_ceiling": 11},
        )

    assert response.status_code == 422


def test_suggestion_requires_authentication(recipe_app: FastAPI) -> None:
    with TestClient(recipe_app) as client:
        response = client.post(
            "/api/recipes/suggestions",
            json={"household_id": HOUSEHOLD_ID},
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
            json={"household_id": HOUSEHOLD_ID},
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
        response_model: type[Any],
        system_instruction: str | None,
        deadline: Any,
        thinking: str | None = None,
    ) -> Any:
        del system_instruction, deadline, thinking
        await asyncio.sleep(self.delay_seconds)
        if response_model.__name__ == "MealChecklist":
            return response_model(checks=[_eligible()])
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
            json={"household_id": HOUSEHOLD_ID},
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
            json={"household_id": HOUSEHOLD_ID},
        )

    assert response.status_code == 200


def test_suggestion_reads_the_requested_households_foods(
    recipe_app: FastAPI,
    signing_key: SigningKey,
    patch_jwks,
) -> None:
    patch_jwks([signing_key])
    foods = FakeFoodLineSource(_inventory())
    _install_graph_dependencies(
        recipe_app,
        FakeProvider([{"recipes": [_recipe()]}, {"checks": [_eligible()]}]),
        foods=foods,
    )

    with TestClient(recipe_app) as client:
        response = client.post(
            "/api/recipes/suggestions",
            headers=_auth_headers(signing_key),
            json={"household_id": HOUSEHOLD_ID},
        )

    assert response.status_code == 200
    assert foods.household_ids == [UUID(HOUSEHOLD_ID)]


def test_suggestion_requires_a_household(
    recipe_app: FastAPI,
    signing_key: SigningKey,
    patch_jwks,
) -> None:
    patch_jwks([signing_key])

    with TestClient(recipe_app) as client:
        response = client.post(
            "/api/recipes/suggestions",
            headers=_auth_headers(signing_key),
            json={"inventory": _inventory()},
        )

    assert response.status_code == 422


def test_unreadable_foods_return_ai_unavailable(
    recipe_app: FastAPI,
    signing_key: SigningKey,
    patch_jwks,
) -> None:
    class FailingFoods:
        async def list_food_lines(self, household_id: Any) -> list[Any]:
            raise FoodLinesError("Reading food_stock failed")

    patch_jwks([signing_key])
    _install_graph_dependencies(recipe_app, FakeProvider([]))
    recipe_app.dependency_overrides[get_food_line_source] = FailingFoods

    with TestClient(recipe_app) as client:
        response = client.post(
            "/api/recipes/suggestions",
            headers=_auth_headers(signing_key),
            json={"household_id": HOUSEHOLD_ID},
        )

    assert response.status_code == 503
    assert response.json()["code"] == "AI_UNAVAILABLE"
