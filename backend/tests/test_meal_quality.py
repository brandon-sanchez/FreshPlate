"""Enforce meal-review decisions without claiming to test model judgement."""

import asyncio
import json
from pathlib import Path

import pytest

from app.ai.agents.graph import build_recipe_generation_graph, build_recipe_graph
from app.ai.agents.meal_quality import MealAssessment, assess_meals, review_recipes
from app.ai.agents.models import Recipe, RecipeGenerationResponse
from app.ai.agents.nodes import analyze_inventory
from app.ai.llm.errors import ProviderError
from app.ai.llm.providers import FakeProvider
from app.ai.llm.retry import PipelineDeadline

CASES = json.loads(
    (Path(__file__).parents[1] / "app/ai/eval/meal_fixtures.json").read_text()
)


class RecordingProvider(FakeProvider):
    def __init__(self, responses):
        super().__init__(responses)
        self.calls = []

    async def generate(self, prompt, **kwargs):
        self.calls.append({"prompt": prompt, **kwargs})
        return await super().generate(prompt, **kwargs)


class EmptyRetriever:
    async def search(self, query, **kwargs):
        return []


def assessment(*verdicts):
    return {
        "decisions": [
            {"candidate_index": i, "verdict": verdict, "reason": "Fixture decision"}
            for i, verdict in enumerate(verdicts)
        ]
    }


def inventory():
    return [
        {"id": item["inventory_item_id"], "name": item["name"],
         "quantity": item["use_amount"] * 2, "unit": item["unit"]}
        for case in CASES[:2] for item in case["recipe"]["ingredients"]
    ]


@pytest.mark.asyncio
@pytest.mark.parametrize("case", CASES, ids=lambda case: case["name"])
async def test_curated_meal_decisions_control_returned_recipes(case):
    recipe = Recipe.model_validate(case["recipe"])
    provider = FakeProvider([assessment(case["expected_verdict"])])
    valid, feedback, _ = await assess_meals(
        [recipe], {}, provider, deadline=PipelineDeadline(30)
    )
    assert valid == ([recipe] if case["expected_verdict"] == "eligible" else [])
    assert (feedback is None) == (case["expected_verdict"] == "eligible")


@pytest.mark.asyncio
@pytest.mark.parametrize("refill", [False, True])
async def test_both_graphs_regenerate_rejected_meals_under_one_deadline(refill):
    token, substantial = [case["recipe"] for case in CASES[:2]]
    provider = RecordingProvider([
        {"recipes": [token]}, assessment("insufficient"),
        {"recipes": [substantial]}, assessment("eligible"),
    ])
    state = {"inventory": inventory(), "metadata": {"trace_key": "keep"}}
    if refill:
        state.update(analyze_inventory(state))
        graph = build_recipe_generation_graph(provider)
    else:
        graph = build_recipe_graph(provider, EmptyRetriever())
    result = await graph.ainvoke(state)
    assert [r.model_dump() for r in result["valid_recipes"]] == [substantial]
    assert result["retry_count"] == 1
    assert [call["response_model"] for call in provider.calls] == [
        RecipeGenerationResponse, MealAssessment,
        RecipeGenerationResponse, MealAssessment,
    ]
    assert all(call["deadline"] is result["deadline"] for call in provider.calls)
    assert "insufficient" in provider.calls[2]["prompt"]
    assert result["metadata"]["trace_key"] == "keep"
    assert result["metadata"]["assessment_prompt_version"] == 1


@pytest.mark.asyncio
async def test_semantically_rejected_meals_exhaust_existing_retry_and_return_empty():
    recipe = CASES[0]["recipe"]
    provider = RecordingProvider([
        {"recipes": [recipe]}, assessment("insufficient"),
        {"recipes": [recipe]}, assessment("unknown"),
    ])
    result = await build_recipe_graph(provider, EmptyRetriever()).ainvoke(
        {"inventory": inventory()}
    )
    assert result["valid_recipes"] == []
    assert result["retry_count"] == 1
    assert len(provider.calls) == 4


@pytest.mark.asyncio
async def test_invalid_inventory_skips_semantic_provider_call():
    recipe = Recipe.model_validate(CASES[0]["recipe"])
    result = await review_recipes(
        {"usable_items": [], "generated_recipes": [recipe]},
        FakeProvider([]), deadline=PipelineDeadline(30),
    )
    assert result["valid_recipes"] == []
    assert "missing inventory" in result["quality_feedback"]


@pytest.mark.asyncio
async def test_quality_feedback_keeps_inventory_and_semantic_rejections():
    recipe = Recipe.model_validate(CASES[0]["recipe"])
    invalid = recipe.model_copy(update={"title": "Invalid inventory"})
    invalid.ingredients = [recipe.ingredients[0].model_copy(
        update={"inventory_item_id": "foreign"}
    )]
    state = {**analyze_inventory({"inventory": inventory()}),
             "generated_recipes": [invalid, recipe]}
    provider = RecordingProvider([assessment("insufficient")])
    result = await review_recipes(state, provider, deadline=PipelineDeadline(30))
    assert "missing inventory" in result["quality_feedback"]
    assert "insufficient" in result["quality_feedback"]
    assert len(json.loads(provider.calls[0]["prompt"])["candidates"]) == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("indices", [[], [0], [0, 0], [-1, 0], [0, 2], [True, 0]])
async def test_incomplete_or_ambiguous_assessments_never_release_recipes(indices):
    recipes = [Recipe.model_validate(case["recipe"]) for case in CASES[:2]]
    response = {"decisions": [
        {"candidate_index": index, "verdict": "eligible", "reason": "Enough"}
        for index in indices
    ]}
    with pytest.raises(ProviderError):
        await assess_meals(
            recipes, {}, FakeProvider([response]), deadline=PipelineDeadline(30)
        )


@pytest.mark.asyncio
async def test_reordered_decisions_preserve_original_recipe_order_and_content():
    recipes = [Recipe.model_validate(case["recipe"]) for case in CASES[:2]]
    before = [recipe.model_dump() for recipe in recipes]
    response = assessment("eligible", "eligible")
    response["decisions"].reverse()
    result, _, _ = await assess_meals(
        recipes, {}, FakeProvider([response]), deadline=PipelineDeadline(30)
    )
    assert all(actual is original for actual, original in zip(result, recipes))
    assert [recipe.model_dump() for recipe in result] == before


@pytest.mark.asyncio
@pytest.mark.parametrize("response", [ProviderError("offline"), {"decisions": None}])
async def test_provider_or_schema_failure_never_releases_unreviewed_recipe(response):
    with pytest.raises(ProviderError):
        await assess_meals(
            [Recipe.model_validate(CASES[0]["recipe"])], {},
            FakeProvider([response]), deadline=PipelineDeadline(30),
        )


@pytest.mark.asyncio
async def test_assessment_cancellation_propagates():
    class CancelledProvider:
        async def generate(self, *args, **kwargs):
            raise asyncio.CancelledError

    with pytest.raises(asyncio.CancelledError):
        await assess_meals(
            [Recipe.model_validate(CASES[0]["recipe"])], {},
            CancelledProvider(), deadline=PipelineDeadline(30),
        )


@pytest.mark.asyncio
async def test_assessment_cannot_release_a_response_after_deadline():
    now = [0.0]
    deadline = PipelineDeadline(30, clock=lambda: now[0])

    class LateProvider:
        async def generate(self, *args, **kwargs):
            now[0] = 31.0
            return MealAssessment.model_validate(assessment("eligible"))

    with pytest.raises(ProviderError, match="deadline"):
        await assess_meals(
            [Recipe.model_validate(CASES[0]["recipe"])], {},
            LateProvider(), deadline=deadline,
        )
