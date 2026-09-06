"""Behavior tests for recipe generation, quality checks, and graph wiring."""

from __future__ import annotations

from datetime import date
from typing import Any

import pytest

from app.ai.agents.graph import build_recipe_graph
from app.ai.agents.models import Recipe, RecipeGenerationResponse
from app.ai.agents.nodes import check_quality, generate_recipes
from app.ai.llm.providers import FakeProvider
from app.ai.llm.retry import PipelineDeadline
from app.ai.prompts.loader import load_prompt
from app.ai.prompts.tracing import build_trace_config
from app.ai.rag.vector_store import RetrievedRecipe


def _ingredient(
    name: str,
    *,
    inventory_item_id: str | None,
    use_amount: float | None,
    unit: str,
) -> dict[str, Any]:
    return {
        "name": name,
        "inventory_item_id": inventory_item_id,
        "use_amount": use_amount,
        "unit": unit,
    }


def _recipe(
    *ingredients: dict[str, Any], title: str = "Tomato Pasta"
) -> dict[str, Any]:
    return {
        "title": title,
        "cook_time_minutes": 20,
        "servings": 2,
        "ingredients": list(ingredients),
        "steps": ["Boil the pasta.", "Toss everything together."],
    }


def _usable_item(
    item_id: str = "tomatoes",
    *,
    name: str = "Tomatoes",
    quantity: float = 3.0,
    unit: str = "item",
) -> dict[str, Any]:
    return {
        "id": item_id,
        "name": name,
        "quantity": quantity,
        "unit": unit,
        "expiration_date": date(2026, 8, 8),
        "days_until_expiration": 5,
        "is_expiring": True,
    }


class RecordingProvider:
    def __init__(self, responses: list[dict[str, Any]]) -> None:
        self._provider = FakeProvider(responses)
        self.calls: list[dict[str, Any]] = []

    async def generate(self, prompt: str, **kwargs: Any) -> RecipeGenerationResponse:
        self.calls.append({"prompt": prompt, **kwargs})
        return await self._provider.generate(
            prompt,
            response_model=kwargs["response_model"],
            system_instruction=kwargs.get("system_instruction"),
            deadline=kwargs.get("deadline"),
        )


class RecordingRetriever:
    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []

    async def search(self, query: str, **kwargs: Any) -> list[RetrievedRecipe]:
        self.calls.append({"query": query, **kwargs})
        return [
            RetrievedRecipe(
                id=101,
                title="Tomato Pasta Inspiration",
                content="Cook tomatoes with pasta.",
                similarity=0.9,
            )
        ]


@pytest.mark.asyncio
async def test_generate_recipes_preserves_provider_amounts_for_quality_validation(
    ) -> None:
    provider = RecordingProvider(
        [
            {
                "recipes": [
                    _recipe(
                        _ingredient(
                            "Tomatoes",
                            inventory_item_id="tomatoes",
                            use_amount=8,
                            unit="item",
                        )
                    )
                ]
            }
        ]
    )
    deadline = PipelineDeadline(5.0)
    prompt = load_prompt("generate_recipes")

    result = await generate_recipes(
        {
            "usable_items": [_usable_item()],
            "retrieved_recipes": [
                RetrievedRecipe(
                    id=101,
                    title="Tomato Pasta Inspiration",
                    content="Cook tomatoes with pasta.",
                    similarity=0.9,
                )
            ],
            "preferences": {"meal": "dinner"},
            "exclude_titles": [],
            "batch_ceiling": 2,
            "retry_count": 0,
        },
        provider,
        prompt=prompt,
        deadline=deadline,
    )

    ingredient = result["generated_recipes"][0].ingredients[0]
    assert ingredient.use_amount == 8
    assert ingredient.unit == "item"
    assert provider.calls[0]["deadline"] is deadline
    assert provider.calls[0]["system_instruction"] == prompt.system
    assert "3.0 item" in provider.calls[0]["prompt"]
    assert "inspiration" in provider.calls[0]["prompt"].lower()
    assert "only the listed inventory" in provider.calls[0]["prompt"].lower()


def test_check_quality_drops_invalid_mappings_and_returns_feedback() -> None:
    valid = Recipe.model_validate(
        _recipe(
            _ingredient(
                "Tomatoes",
                inventory_item_id="tomatoes",
                use_amount=2,
                unit="item",
            )
        )
    )
    invalid = Recipe.model_validate(
        _recipe(
            _ingredient(
                "Unknown ingredient",
                inventory_item_id="missing",
                use_amount=1,
                unit="item",
            ),
            title="Ungrounded Pasta",
        )
    )

    result = check_quality(
        {
            "usable_items": [_usable_item()],
            "generated_recipes": [valid, invalid],
        }
    )

    assert result["valid_recipes"] == [valid]
    assert result["quality_feedback"] is not None
    assert "missing" in result["quality_feedback"]


def test_check_quality_rejects_incomplete_staple_amounts() -> None:
    incomplete = Recipe.model_validate(
        _recipe(
            _ingredient(
                "Salt",
                inventory_item_id=None,
                use_amount=None,
                unit="pinch",
            ),
            _ingredient(
                "Tomatoes",
                inventory_item_id="tomatoes",
                use_amount=2,
                unit="item",
            ),
        )
    )

    result = check_quality(
        {
            "usable_items": [_usable_item()],
            "generated_recipes": [incomplete],
        }
    )

    assert result["valid_recipes"] == []
    assert result["quality_feedback"] is not None
    assert "missing use_amount" in result["quality_feedback"]


@pytest.mark.asyncio
async def test_generate_recipes_preserves_unit_mismatched_inventory_links() -> None:
    butter_item = _usable_item(
        "butter-spread",
        name="Butter with Olive Oil & Sea Salt Spread",
        quantity=1.0,
        unit="Container (14 servings)",
    )
    provider = RecordingProvider(
        [
            {
                "recipes": [
                    _recipe(
                        _ingredient(
                            "Tomatoes",
                            inventory_item_id="tomatoes",
                            use_amount=2,
                            unit="item",
                        ),
                        _ingredient(
                            "Butter spread",
                            inventory_item_id="butter-spread",
                            use_amount=1,
                            unit="tbsp",
                        ),
                    )
                ]
            }
        ]
    )

    result = await generate_recipes(
        {
            "usable_items": [_usable_item(), butter_item],
            "retrieved_recipes": [],
            "preferences": {},
            "exclude_titles": [],
            "batch_ceiling": 2,
            "retry_count": 0,
        },
        provider,
        prompt=load_prompt("generate_recipes"),
        deadline=PipelineDeadline(5.0),
    )

    generated = result["generated_recipes"][0]
    tracked, mismatched = generated.ingredients
    assert tracked.inventory_item_id == "tomatoes"
    assert mismatched.inventory_item_id == "butter-spread"
    assert mismatched.unit == "tbsp"
    assert mismatched.use_amount == 1

    quality = check_quality(
        {
            "usable_items": [_usable_item(), butter_item],
            "generated_recipes": [generated],
        }
    )
    assert quality["valid_recipes"] == []
    assert "uses unit 'tbsp'" in quality["quality_feedback"]


def test_check_quality_rejects_duplicate_inventory_overuse() -> None:
    recipe = Recipe.model_validate(
        _recipe(
            _ingredient(
                "Tomatoes", inventory_item_id="tomatoes", use_amount=2, unit="item"
            ),
            _ingredient(
                "More tomatoes", inventory_item_id="tomatoes", use_amount=2, unit="item"
            ),
        )
    )
    result = check_quality(
        {"usable_items": [_usable_item()], "generated_recipes": [recipe]}
    )
    assert result["valid_recipes"] == []
    assert "in total" in result["quality_feedback"]


@pytest.mark.asyncio
async def test_graph_retries_once_with_quality_feedback_and_shared_deadline() -> None:
    bad_response = {
        "recipes": [
            _recipe(
                _ingredient(
                    "Unknown ingredient",
                    inventory_item_id="missing",
                    use_amount=1,
                    unit="item",
                ),
                title="First attempt",
            )
        ]
    }
    good_response = {
        "recipes": [
            _recipe(
                _ingredient(
                    "Tomatoes",
                    inventory_item_id="tomatoes",
                    use_amount=2,
                    unit="item",
                ),
                title="Second attempt",
            )
        ]
    }
    provider = RecordingProvider([bad_response, good_response])
    retriever = RecordingRetriever()
    prompt = load_prompt("generate_recipes")
    deadline = PipelineDeadline(25.0)
    graph = build_recipe_graph(provider, retriever, prompt=prompt)

    result = await graph.ainvoke(
        {
            "inventory": [
                {
                    "id": "tomatoes",
                    "name": "Tomatoes",
                    "quantity": 3,
                    "unit": "item",
                    "expiration_date": None,
                }
            ],
            "preferences": {"meal": "dinner"},
            "exclude_titles": [],
            "batch_ceiling": 2,
            "retry_count": 0,
            "metadata": {},
            "deadline": deadline,
        },
        config=build_trace_config(prompt, request_id="request-123"),
    )

    assert [recipe.title for recipe in result["valid_recipes"]] == [
        "Second attempt"
    ]
    assert result["retry_count"] == 1
    assert len(provider.calls) == 2
    assert "missing" in provider.calls[1]["prompt"]
    assert provider.calls[0]["deadline"] is deadline
    assert provider.calls[1]["deadline"] is deadline
    assert retriever.calls[0]["deadline"] is deadline
    assert result["metadata"]["prompt_name"] == "generate_recipes"
    assert result["metadata"]["prompt_version"] == 3
    assert result["metadata"]["request_id"] == "request-123"


@pytest.mark.asyncio
async def test_graph_fail_softs_after_one_quality_retry() -> None:
    invalid_response = {
        "recipes": [
            _recipe(
                _ingredient(
                    "Unknown ingredient",
                    inventory_item_id="missing",
                    use_amount=1,
                    unit="item",
                )
            )
        ]
    }
    provider = RecordingProvider([invalid_response, invalid_response])
    graph = build_recipe_graph(provider, RecordingRetriever())

    result = await graph.ainvoke(
        {
            "inventory": [
                {
                    "id": "tomatoes",
                    "name": "Tomatoes",
                    "quantity": 3,
                    "unit": "item",
                    "expiration_date": None,
                }
            ],
            "preferences": {},
            "exclude_titles": [],
            "batch_ceiling": 1,
        }
    )

    assert result["valid_recipes"] == []
    assert result["retry_count"] == 1
    assert len(provider.calls) == 2


@pytest.mark.asyncio
async def test_graph_honors_a_quality_retry_limit_above_the_default() -> None:
    """The retry counter must stay truthful for limits above the default.

    Regression: capping retry_count at MAX_QUALITY_RETRIES made any higher
    configured limit retry until the deadline instead of stopping at the
    caller's bound.
    """
    invalid_response = {
        "recipes": [
            _recipe(
                _ingredient(
                    "Unknown ingredient",
                    inventory_item_id="missing",
                    use_amount=1,
                    unit="item",
                )
            )
        ]
    }
    provider = RecordingProvider([invalid_response] * 3)
    graph = build_recipe_graph(
        provider,
        RecordingRetriever(),
        quality_retry_limit=2,
    )

    result = await graph.ainvoke(
        {
            "inventory": [
                {
                    "id": "tomatoes",
                    "name": "Tomatoes",
                    "quantity": 3,
                    "unit": "item",
                    "expiration_date": None,
                }
            ],
            "preferences": {},
            "exclude_titles": [],
            "batch_ceiling": 1,
            "deadline": PipelineDeadline(25.0),
        }
    )

    assert result["valid_recipes"] == []
    assert result["retry_count"] == 2
    assert len(provider.calls) == 3


@pytest.mark.asyncio
async def test_graph_skips_quality_retry_below_the_20s_budget_floor() -> None:
    """One generation measures 16-24s, so a retry needs at least that budget.

    Regression for the #42 fix: a zero-valid generation late in the budget
    must finish honestly instead of firing a retry that can only time out
    or trip Gemini's 10-second minimum HTTP deadline.
    """
    invalid_response = {
        "recipes": [
            _recipe(
                _ingredient(
                    "Unknown ingredient",
                    inventory_item_id="missing",
                    use_amount=1,
                    unit="item",
                )
            )
        ]
    }
    provider = RecordingProvider([invalid_response, invalid_response])
    graph = build_recipe_graph(provider, RecordingRetriever())

    result = await graph.ainvoke(
        {
            "inventory": [
                {
                    "id": "tomatoes",
                    "name": "Tomatoes",
                    "quantity": 3,
                    "unit": "item",
                    "expiration_date": None,
                }
            ],
            "preferences": {},
            "exclude_titles": [],
            "batch_ceiling": 1,
            "deadline": PipelineDeadline(15.0),
        }
    )

    assert result["valid_recipes"] == []
    assert result["retry_count"] == 0
    assert len(provider.calls) == 1
