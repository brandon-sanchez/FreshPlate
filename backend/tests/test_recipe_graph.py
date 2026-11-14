"""Behavior tests for recipe generation, quality checks, and graph wiring."""

from __future__ import annotations

from datetime import date
from typing import Any

import pytest

from app.ai.agents.graph import build_recipe_graph
from app.ai.agents.models import Recipe, RecipeGenerationResponse
from app.ai.agents.nodes import analyze_inventory, check_quality, generate_recipes
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
    stock_base: str = "each",
    each_label: str | None = "each",
    **facts: Any,
) -> dict[str, Any]:
    food = {
        "id": item_id,
        "name": name,
        "available": quantity,
        "next_expiry": "2026-08-08",
        "stock_base": stock_base,
        "each_label": each_label if stock_base == "each" else None,
        **facts,
    }
    analysis = analyze_inventory({"inventory": [food]}, today=date(2026, 8, 3))
    return dict(analysis["usable_items"][0])


TOMATOES = {
    "id": "tomatoes",
    "name": "Tomatoes",
    "available": 3,
    "stock_base": "each",
    "each_label": "each",
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
            thinking=kwargs.get("thinking"),
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
async def test_generate_recipes_preserves_provider_amounts_for_quality_validation() -> (
    None
):
    provider = RecordingProvider(
        [
            {
                "recipes": [
                    _recipe(
                        _ingredient(
                            "Tomatoes",
                            inventory_item_id="tomatoes",
                            use_amount=8,
                            unit="each",
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
    assert ingredient.unit == "each"
    assert provider.calls[0]["deadline"] is deadline
    assert provider.calls[0]["system_instruction"] == prompt.system
    assert "inspiration" in provider.calls[0]["prompt"].lower()
    assert "only the listed inventory" in provider.calls[0]["prompt"].lower()


def test_check_quality_drops_invalid_mappings_and_returns_feedback() -> None:
    valid = Recipe.model_validate(
        _recipe(
            _ingredient(
                "Tomatoes",
                inventory_item_id="tomatoes",
                use_amount=2,
                unit="each",
            )
        )
    )
    invalid = Recipe.model_validate(
        _recipe(
            _ingredient(
                "Unknown ingredient",
                inventory_item_id="missing",
                use_amount=1,
                unit="each",
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
                unit="each",
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
async def test_generation_lists_one_line_per_food_with_its_units() -> None:
    provider = RecordingProvider([{"recipes": []}])
    milk = _usable_item(
        "milk", name="Milk", quantity=5400, stock_base="ml", lot_count=2
    )

    await generate_recipes(
        {"usable_items": [_usable_item(), milk], "batch_ceiling": 1}, provider
    )

    prompt = provider.calls[0]["prompt"]
    assert (
        "- tomatoes: Tomatoes | 3 each | next expires 2026-08-08, expiring soon "
        "| units: each, tsp, tbsp, pinch, dash"
    ) in prompt
    assert (
        "- milk: Milk | 5400 ml | 2 batches | next expires 2026-08-08, expiring "
        "soon | units: ml, oz, l, tsp, tbsp, cup, fl oz, pinch, dash"
    ) in prompt
    assert "own unit" not in prompt


@pytest.mark.asyncio
async def test_generation_schema_limits_each_ingredient_to_its_foods_units() -> None:
    provider = RecordingProvider([{"recipes": []}])
    garlic = _usable_item(
        "garlic",
        name="Garlic",
        quantity=1,
        each_label="head",
        household_units={"clove": 0.1},
    )

    await generate_recipes(
        {"usable_items": [_usable_item(), garlic], "batch_ceiling": 1}, provider
    )

    schema = provider.calls[0]["response_model"].model_json_schema()
    recipe_schema = schema["$defs"]["KitchenRecipe"]
    variants = recipe_schema["properties"]["ingredients"]["items"]["anyOf"]
    allowed = {
        variant["properties"]["inventory_item_id"]["enum"][0]: variant["properties"][
            "unit"
        ]["enum"]
        for variant in variants
    }
    assert allowed == {
        "tomatoes": ["each", "tsp", "tbsp", "pinch", "dash"],
        "garlic": [
            "head",
            "clove",
            "tsp",
            "tbsp",
            "pinch",
            "dash",
        ],  # fmt: skip
    }
    assert all(
        variant["required"] == ["name", "inventory_item_id", "use_amount", "unit"]
        for variant in variants
    )


@pytest.mark.asyncio
async def test_a_kitchen_with_no_usable_food_makes_no_generation_call() -> None:
    provider = RecordingProvider([])

    result = await generate_recipes({"usable_items": []}, provider)

    assert result == {"generated_recipes": [], "retry_count": 0}
    assert provider.calls == []


def test_check_quality_converts_amounts_before_comparing_with_stock() -> None:
    garlic = _usable_item(
        "garlic",
        name="Garlic",
        quantity=1,
        each_label="head",
        household_units={"clove": 0.1},
    )
    milk = _usable_item("milk", name="Milk", quantity=500, stock_base="ml")
    fits = Recipe.model_validate(
        _recipe(
            _ingredient(
                "Garlic", inventory_item_id="garlic", use_amount=3, unit="cloves"
            ),
            _ingredient("Milk", inventory_item_id="milk", use_amount=2, unit="cup"),
            title="Garlic Milk Soup",
        )
    )
    too_much_garlic = Recipe.model_validate(
        _recipe(
            _ingredient(
                "Garlic", inventory_item_id="garlic", use_amount=8, unit="clove"
            ),
            _ingredient(
                "Garlic", inventory_item_id="garlic", use_amount=4, unit="clove"
            ),
            title="Forty Clove Chicken",
        )
    )
    too_much_milk = Recipe.model_validate(
        _recipe(
            _ingredient("Milk", inventory_item_id="milk", use_amount=3, unit="cups"),
            title="Milk Pudding",
        )
    )

    result = check_quality(
        {
            "usable_items": [garlic, milk],
            "generated_recipes": [fits, too_much_garlic, too_much_milk],
        }
    )

    assert result["valid_recipes"] == [fits]
    assert (
        "Recipe 'Forty Clove Chicken': ingredients mapped to inventory item "
        "'garlic' need 1.2 head in total, more than the available 1 head"
    ) in result["quality_feedback"]
    assert "'milk' need 709.765 ml in total" in result["quality_feedback"]


def test_check_quality_leaves_estimated_and_unconvertible_amounts_to_the_cook() -> None:
    garlic = _usable_item(
        "garlic",
        name="Garlic",
        quantity=1,
        each_label="head",
        profile_key="garlic",
        profile_unit_grams={"clove": 3, "head": 40},
    )
    butter = _usable_item("butter", name="Butter", quantity=10, stock_base="g")
    recipe = Recipe.model_validate(
        _recipe(
            _ingredient(
                "Garlic", inventory_item_id="garlic", use_amount=20, unit="clove"
            ),
            _ingredient(
                "Butter", inventory_item_id="butter", use_amount=4, unit="tbsp"
            ),
            _ingredient(
                "Butter", inventory_item_id="butter", use_amount=1, unit="knob"
            ),
            title="Garlic Butter",
        )
    )

    result = check_quality(
        {"usable_items": [garlic, butter], "generated_recipes": [recipe]}
    )

    assert result["valid_recipes"] == [recipe]
    assert result["quality_feedback"] is None


def test_check_quality_rejects_duplicate_inventory_overuse() -> None:
    recipe = Recipe.model_validate(
        _recipe(
            _ingredient(
                "Tomatoes", inventory_item_id="tomatoes", use_amount=2, unit="each"
            ),
            _ingredient(
                "Tomatoes", inventory_item_id="tomatoes", use_amount=2, unit="each"
            ),
        )
    )
    result = check_quality(
        {
            "usable_items": [_usable_item()],
            "generated_recipes": [recipe],
        }
    )
    assert result["valid_recipes"] == []
    assert "in total" in result["quality_feedback"]


def test_check_quality_accepts_decimal_amounts_at_exact_inventory_total() -> None:
    recipe = Recipe.model_validate(
        _recipe(
            _ingredient(
                "Tomatoes", inventory_item_id="tomatoes", use_amount=0.1, unit="each"
            ),
            _ingredient(
                "Tomatoes", inventory_item_id="tomatoes", use_amount=0.2, unit="each"
            ),
        )
    )
    result = check_quality(
        {
            "usable_items": [_usable_item(quantity=0.3)],
            "generated_recipes": [recipe],
        }
    )
    assert [item.title for item in result["valid_recipes"]] == [recipe.title]


def test_check_quality_rejects_decimal_amounts_over_inventory_total() -> None:
    recipe = Recipe.model_validate(
        _recipe(
            _ingredient(
                "Tomatoes", inventory_item_id="tomatoes", use_amount=0.1, unit="each"
            ),
            _ingredient(
                "Tomatoes", inventory_item_id="tomatoes", use_amount=0.21, unit="each"
            ),
        )
    )
    result = check_quality(
        {
            "usable_items": [_usable_item(quantity=0.3)],
            "generated_recipes": [recipe],
        }
    )
    assert result["valid_recipes"] == []
    assert "in total" in result["quality_feedback"]


def test_check_quality_rejects_null_inventory_id() -> None:
    recipe = Recipe.model_validate(
        _recipe(
            _ingredient("Tomatoes", inventory_item_id=None, use_amount=1, unit="each")
        )
    )
    result = check_quality(
        {"usable_items": [_usable_item()], "generated_recipes": [recipe]}
    )
    assert result["valid_recipes"] == []
    assert "not mapped to inventory" in result["quality_feedback"]


def test_prompt_describes_empty_result_for_unsupported_meals() -> None:
    provider = RecordingProvider([{"recipes": []}])
    import asyncio

    asyncio.run(
        generate_recipes(
            {"usable_items": [_usable_item()], "batch_ceiling": 1},
            provider,
            prompt=load_prompt("generate_recipes"),
        )
    )
    prompt = provider.calls[0]["system_instruction"]
    assert "return an empty recipes list" in prompt
    assert "fixed protein, starch, or calorie pattern" in prompt


@pytest.mark.asyncio
async def test_graph_retries_once_with_quality_feedback_and_shared_deadline() -> None:
    bad_response = {
        "recipes": [
            _recipe(
                _ingredient(
                    "Unknown ingredient",
                    inventory_item_id="missing",
                    use_amount=1,
                    unit="each",
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
                    unit="each",
                ),
                title="Second attempt",
            )
        ]
    }
    provider = RecordingProvider(
        [
            bad_response,
            good_response,
            {
                "checks": [
                    {
                        "candidate_index": 0,
                        "main_component": "pasta",
                        "portion_reasoning": "substantial",
                        "unlisted_foods": [],
                        "is_full_meal": True,
                        "realistic_portions": True,
                        "coherent_method": True,
                    }
                ]
            },
        ]
    )
    retriever = RecordingRetriever()
    prompt = load_prompt("generate_recipes")
    deadline = PipelineDeadline(25.0)
    graph = build_recipe_graph(provider, retriever, prompt=prompt)

    result = await graph.ainvoke(
        {
            "inventory": [TOMATOES],
            "preferences": {"meal": "dinner"},
            "exclude_titles": [],
            "batch_ceiling": 2,
            "retry_count": 0,
            "metadata": {},
            "deadline": deadline,
        },
        config=build_trace_config(prompt, request_id="request-123"),
    )

    assert [recipe.title for recipe in result["valid_recipes"]] == ["Second attempt"]
    assert result["retry_count"] == 1
    assert len(provider.calls) == 3
    assert "missing" in provider.calls[1]["prompt"]
    assert all(call["deadline"] is deadline for call in provider.calls)
    assert retriever.calls[0]["deadline"] is deadline
    assert result["metadata"]["prompt_name"] == "generate_recipes"
    assert result["metadata"]["prompt_version"] == 5
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
                    unit="each",
                )
            )
        ]
    }
    provider = RecordingProvider([invalid_response, invalid_response])
    graph = build_recipe_graph(provider, RecordingRetriever())
    deadline = PipelineDeadline(25.0)

    result = await graph.ainvoke(
        {
            "inventory": [TOMATOES],
            "preferences": {},
            "exclude_titles": [],
            "batch_ceiling": 1,
            "deadline": deadline,
        }
    )

    assert result["valid_recipes"] == []
    assert result["retry_count"] == 1
    assert len(provider.calls) == 2
    assert all(call["deadline"] is deadline for call in provider.calls)


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
                    unit="each",
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
            "inventory": [TOMATOES],
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
                    unit="each",
                )
            )
        ]
    }
    provider = RecordingProvider([invalid_response, invalid_response])
    graph = build_recipe_graph(provider, RecordingRetriever())

    result = await graph.ainvoke(
        {
            "inventory": [TOMATOES],
            "preferences": {},
            "exclude_titles": [],
            "batch_ceiling": 1,
            "deadline": PipelineDeadline(15.0),
        }
    )

    assert result["valid_recipes"] == []
    assert result["retry_count"] == 0
    assert len(provider.calls) == 1


@pytest.mark.asyncio
async def test_generation_runs_at_minimal_thinking_with_a_capped_open_batch() -> None:
    provider = RecordingProvider([{"recipes": []}])
    await generate_recipes(
        {"usable_items": [_usable_item()], "batch_ceiling": 3}, provider
    )

    call = provider.calls[0]
    assert call["thinking"] == "minimal"
    schema = call["response_model"].model_json_schema()["properties"]["recipes"]
    assert schema["maxItems"] == 3
    assert "minItems" not in schema
    assert "Maximum number of recipes: 3" in call["prompt"]
    assert "every recipe may use the full listed inventory" in call["prompt"]
    assert "return an empty list" in call["prompt"]


@pytest.mark.asyncio
async def test_generation_prompt_says_water_is_the_only_free_ingredient() -> None:
    provider = RecordingProvider([{"recipes": []}])
    await generate_recipes({"usable_items": [_usable_item()]}, provider)
    prompt = provider.calls[0]["prompt"]
    assert "Water is always available" in prompt
    assert "salt, pepper, oil" in prompt


def test_check_quality_allows_unmapped_water_but_no_other_unmapped_staple() -> None:
    tomatoes = _ingredient(
        "Tomatoes", inventory_item_id="tomatoes", use_amount=1, unit="each"
    )
    with_water = Recipe.model_validate(
        _recipe(
            tomatoes,
            _ingredient(" Water ", inventory_item_id=None, use_amount=500, unit="ml"),
            title="Tomato Soup",
        )
    )
    with_salt = Recipe.model_validate(
        _recipe(
            tomatoes,
            _ingredient("Salt", inventory_item_id=None, use_amount=2, unit="g"),
            title="Salted Tomatoes",
        )
    )
    only_water = Recipe.model_validate(
        _recipe(
            _ingredient("Water", inventory_item_id=None, use_amount=1, unit="l"),
            title="Hot Water",
        )
    )
    result = check_quality(
        {
            "usable_items": [_usable_item()],
            "generated_recipes": [with_water, with_salt, only_water],
        }
    )
    assert result["valid_recipes"] == [with_water]
    assert "ingredient 'Salt' is not mapped to inventory" in result["quality_feedback"]
    assert "Recipe 'Hot Water': recipe has no grounded" in result["quality_feedback"]


@pytest.mark.asyncio
async def test_honest_empty_batch_finishes_without_a_quality_retry() -> None:
    provider = RecordingProvider([{"recipes": []}])
    result = await build_recipe_graph(provider, RecordingRetriever()).ainvoke(
        {
            "inventory": [
                {"id": "salt", "name": "Salt", "available": 500, "stock_base": "g"}
            ]
        }
    )
    assert result["valid_recipes"] == []
    assert result["retry_count"] == 0
    assert len(provider.calls) == 1


@pytest.mark.asyncio
async def test_graph_accepts_a_recipe_measured_in_a_smaller_unit_than_stock() -> None:
    provider = RecordingProvider(
        [
            {
                "recipes": [
                    _recipe(
                        _ingredient(
                            "Basmati rice",
                            inventory_item_id="rice",
                            use_amount=300,
                            unit="g",
                        ),
                        title="Lemon Herb Rice",
                    )
                ]
            },
            {
                "checks": [
                    {
                        "candidate_index": 0,
                        "main_component": "rice",
                        "portion_reasoning": "substantial",
                        "unlisted_foods": [],
                        "is_full_meal": True,
                        "realistic_portions": True,
                        "coherent_method": True,
                    }
                ]
            },
        ]
    )
    graph = build_recipe_graph(provider, RecordingRetriever())

    result = await graph.ainvoke(
        {
            "inventory": [
                {
                    "id": "rice",
                    "name": "Basmati rice",
                    "available": 2000,
                    "stock_base": "g",
                }
            ],
            "preferences": {},
            "exclude_titles": [],
            "batch_ceiling": 1,
            "deadline": PipelineDeadline(15.0),
        }
    )

    assert [recipe.title for recipe in result["valid_recipes"]] == ["Lemon Herb Rice"]
    assert result["quality_feedback"] is None
    assert result["retry_count"] == 0


@pytest.mark.parametrize(
    ("name", "use_amount", "unit", "quantity", "stock_base"),
    [
        ("Rice", 300, "g", 2000, "g"),
        ("Milk", 2, "cups", 1000, "ml"),
        ("Milk", 8, "oz", 1000, "ml"),
        ("Eggs", 2, "pieces", 3, "each"),
        ("Eggs", 2, "large", 3, "each"),
        ("Flour", 1, "lb", 500, "g"),
        ("Flour", 500, "g", 500, "g"),
    ],
)
def test_check_quality_compares_amounts_in_a_common_unit(
    name: str, use_amount: float, unit: str, quantity: float, stock_base: str
) -> None:
    recipe = Recipe.model_validate(
        _recipe(
            _ingredient(
                name, inventory_item_id="food", use_amount=use_amount, unit=unit
            )
        )
    )

    result = check_quality(
        {
            "usable_items": [
                _usable_item(
                    "food", name=name, quantity=quantity, stock_base=stock_base
                )
            ],
            "generated_recipes": [recipe],
        }
    )

    assert result["valid_recipes"] == [recipe]
    assert result["quality_feedback"] is None


def test_check_quality_rejects_overuse_after_unit_conversion() -> None:
    recipe = Recipe.model_validate(
        _recipe(
            _ingredient(
                "Tomatoes", inventory_item_id="tomatoes", use_amount=1500, unit="g"
            ),
            _ingredient(
                "Tomatoes", inventory_item_id="tomatoes", use_amount=1, unit="kg"
            ),
        )
    )

    result = check_quality(
        {
            "usable_items": [_usable_item(quantity=2000, stock_base="g")],
            "generated_recipes": [recipe],
        }
    )

    assert result["valid_recipes"] == []
    assert (
        "'tomatoes' need 2500 g in total, more than the available 2000 g"
        in result["quality_feedback"]
    )
