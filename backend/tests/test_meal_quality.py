"""Enforce meal-review decisions without claiming to test model judgement."""

import asyncio
import json
from pathlib import Path

import pytest

from app.ai.agents.graph import build_recipe_generation_graph, build_recipe_graph
from app.ai.agents.kitchen_basics import KitchenBasics
from app.ai.agents.meal_quality import MealChecklist, assess_meals, review_recipes
from app.ai.agents.models import Recipe, RecipeGenerationResponse
from app.ai.agents.nodes import (
    MEAL_REVIEW_RESERVE_SECONDS,
    analyze_inventory,
    generate_recipes,
)
from app.ai.llm.errors import ProviderError
from app.ai.llm.providers import FakeProvider
from app.ai.llm.retry import PipelineDeadline
from app.inventory.units import table_unit
from tests.recipe_fakes import NO_BASICS, model_answer

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


def _kind(response_model):
    if issubclass(response_model, RecipeGenerationResponse):
        return RecipeGenerationResponse
    return response_model


class EmptyRetriever:
    async def search(self, query, **kwargs):
        return []


CHECKLIST_ANSWERS = {
    "eligible": {},
    "wrong_dish": {"is_requested_dish": False},
    "thin_portions": {"realistic_portions": False},
    "incoherent": {"coherent_method": False},
    "unsupported_ingredient": {"unlisted_foods": ["cod"]},
}


def check(index, answers="eligible"):
    return {
        "candidate_index": index,
        "main_component": "Fixture main component",
        "dish_reasoning": "Fixture dish",
        "portion_reasoning": "Fixture portions",
        "unlisted_foods": [],
        "is_requested_dish": True,
        "realistic_portions": True,
        "coherent_method": True,
        **CHECKLIST_ANSWERS[answers],
    }


def assessment(*verdicts):
    return {"checks": [check(i, verdict) for i, verdict in enumerate(verdicts)]}


TBSP_ML = table_unit("tbsp")[1]


def _food_line(ingredient):
    unit = ingredient["unit"]
    line = {"id": ingredient["inventory_item_id"], "name": ingredient["name"]}
    if unit == "g":
        return {**line, "available": ingredient["use_amount"] * 2, "stock_base": "g"}
    if unit == "tbsp":
        ml = ingredient["use_amount"] * float(TBSP_ML) * 2
        return {**line, "available": ml, "stock_base": "ml"}
    return {
        **line,
        "available": ingredient["use_amount"] * 2,
        "stock_base": "each",
        "each_label": unit,
    }


def inventory():
    return [
        _food_line(item)
        for case in CASES[:2] for item in case["recipe"]["ingredients"]
    ]


@pytest.mark.asyncio
@pytest.mark.parametrize("case", CASES, ids=lambda case: case["name"])
async def test_curated_meal_decisions_control_returned_recipes(case):
    recipe = Recipe.model_validate(case["recipe"])
    provider = RecordingProvider([assessment(case["expected_verdict"])])
    state = {"kitchen_basics": NO_BASICS, "preferences": case.get("preferences", {})}
    valid, feedback, _ = await assess_meals(
        [recipe], state, provider, deadline=PipelineDeadline(30)
    )
    assert valid == ([recipe] if case["expected_verdict"] == "eligible" else [])
    assert (feedback is None) == (case["expected_verdict"] == "eligible")
    payload = json.loads(provider.calls[0]["prompt"])
    assert payload["requested_dish"] == case.get("requested_dish", "meal")


@pytest.mark.asyncio
@pytest.mark.parametrize("refill", [False, True])
async def test_both_graphs_regenerate_rejected_meals_under_one_deadline(refill):
    token, substantial = [case["recipe"] for case in CASES[:2]]
    provider = RecordingProvider([
        {"recipes": [model_answer(token, inventory(), NO_BASICS)]},
        assessment("wrong_dish"),
        {"recipes": [model_answer(substantial, inventory(), NO_BASICS)]},
        assessment("eligible"),
    ])
    state = {
        "kitchen_basics": NO_BASICS,
        "inventory": inventory(),
        "metadata": {"trace_key": "keep"},
        "batch_ceiling": 1,
    }
    if refill:
        state.update(analyze_inventory(state))
        graph = build_recipe_generation_graph(provider)
    else:
        graph = build_recipe_graph(provider, EmptyRetriever())
    result = await graph.ainvoke(state)
    assert [r.model_dump() for r in result["valid_recipes"]] == [
        Recipe.model_validate(substantial).model_dump()
    ]
    assert result["retry_count"] == 1
    assert [_kind(call["response_model"]) for call in provider.calls] == [
        RecipeGenerationResponse, MealChecklist,
        RecipeGenerationResponse, MealChecklist,
    ]
    review_calls = provider.calls[1::2]
    assert all(call["deadline"] is result["deadline"] for call in review_calls)
    review_end = result["deadline"].remaining_seconds - MEAL_REVIEW_RESERVE_SECONDS
    assert all(
        abs(call["deadline"].remaining_seconds - review_end) < 0.5
        for call in provider.calls[::2]
    )
    assert "wrong_dish: not a meal on its own" in provider.calls[2]["prompt"]
    assert result["metadata"]["trace_key"] == "keep"
    assert result["metadata"]["assessment_prompt_version"] == 4


@pytest.mark.asyncio
async def test_semantically_rejected_meals_exhaust_existing_retry_and_return_empty():
    recipe = model_answer(CASES[0]["recipe"], inventory(), NO_BASICS)
    provider = RecordingProvider([
        {"recipes": [recipe]}, assessment("wrong_dish"),
        {"recipes": [recipe]}, assessment("wrong_dish"),
    ])
    result = await build_recipe_graph(provider, EmptyRetriever()).ainvoke(
        {"kitchen_basics": NO_BASICS, "inventory": inventory(), "batch_ceiling": 1}
    )
    assert result["valid_recipes"] == []
    assert result["retry_count"] == 1
    assert len(provider.calls) == 4


@pytest.mark.asyncio
async def test_invalid_inventory_skips_semantic_provider_call():
    recipe = Recipe.model_validate(CASES[0]["recipe"])
    result = await review_recipes(
        {
            "kitchen_basics": NO_BASICS,
            "usable_items": [],
            "generated_recipes": [recipe],
        },
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
    state = {**analyze_inventory({"kitchen_basics": NO_BASICS,
                                  "inventory": inventory()}),
             "generated_recipes": [invalid, recipe]}
    provider = RecordingProvider([assessment("wrong_dish")])
    result = await review_recipes(state, provider, deadline=PipelineDeadline(30))
    assert "missing inventory" in result["quality_feedback"]
    assert "wrong_dish" in result["quality_feedback"]
    assert len(json.loads(provider.calls[0]["prompt"])["candidates"]) == 1


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("answers", "verdict"),
    [
        ("wrong_dish", "wrong_dish"),
        ("thin_portions", "insufficient"),
        ("incoherent", "incoherent"),
        ("unsupported_ingredient", "unsupported_ingredient"),
    ],
)
async def test_any_failed_checklist_answer_rejects_the_meal(answers, verdict):
    recipe = Recipe.model_validate(CASES[1]["recipe"])
    valid, feedback, _ = await assess_meals(
        [recipe], {"kitchen_basics": NO_BASICS},
        FakeProvider([{"checks": [check(0, answers)]}]),
        deadline=PipelineDeadline(30),
    )
    assert valid == []
    assert f"Recipe '{recipe.title}': {verdict}" in feedback


@pytest.mark.asyncio
async def test_the_judge_catches_a_food_written_on_a_basics_label():
    basics = KitchenBasics(["Salt", "Water"])
    pasta = CASES[1]["recipe"]
    water = {"name": "Water", "inventory_item_id": None, "use_amount": 250,
             "unit": "ml"}
    answer = model_answer(
        {**pasta, "ingredients": [*pasta["ingredients"], water]}, inventory(), basics
    )
    answer["ingredients"][-1]["name"] = "Chicken stock"
    rejection = {**check(0), "unlisted_foods": ["Chicken stock"]}
    provider = RecordingProvider([{"recipes": [answer]}, {"checks": [rejection]}])
    state = {
        **analyze_inventory({"kitchen_basics": basics, "inventory": inventory()}),
        "batch_ceiling": 1,
    }

    generated = await generate_recipes(state, provider)
    result = await review_recipes(
        {**state, **generated}, provider, deadline=PipelineDeadline(30)
    )

    [candidate] = json.loads(provider.calls[1]["prompt"])["candidates"]
    assert {"name": "Chicken stock", "inventory_item_id": None}.items() <= next(
        item for item in candidate["recipe"]["ingredients"]
        if item["name"] == "Chicken stock"
    ).items()
    assert result["valid_recipes"] == []
    assert "Chicken stock" in result["quality_feedback"]


@pytest.mark.asyncio
async def test_kitchen_basics_are_never_unlisted_foods():
    recipe = Recipe.model_validate(CASES[1]["recipe"])
    response = {"checks": [{**check(0), "unlisted_foods": [" salt ", "Water"]}]}
    provider = RecordingProvider([response])
    valid, feedback, _ = await assess_meals(
        [recipe],
        {"kitchen_basics": KitchenBasics(["Salt", "Water"])},
        provider,
        deadline=PipelineDeadline(30),
    )
    assert valid == [recipe]
    assert feedback is None
    assert json.loads(provider.calls[0]["prompt"])["kitchen_basics"] == [
        "Salt",
        "Water",
    ]


@pytest.mark.asyncio
async def test_water_is_unlisted_when_the_household_has_no_such_basic():
    recipe = Recipe.model_validate(CASES[1]["recipe"])
    response = {"checks": [{**check(0), "unlisted_foods": ["Water"]}]}
    valid, feedback, _ = await assess_meals(
        [recipe], {"kitchen_basics": NO_BASICS}, FakeProvider([response]),
        deadline=PipelineDeadline(30),
    )
    assert valid == []
    assert "unsupported_ingredient" in feedback


@pytest.mark.asyncio
async def test_judge_sees_only_each_recipes_own_inventory_items_at_minimal_thinking():
    recipe = Recipe.model_validate(CASES[1]["recipe"])
    unrelated = {
        "id": "unrelated",
        "name": "Anchovies",
        "available": 1,
        "stock_base": "each",
        "each_label": "can",
    }
    state = analyze_inventory(
        {"kitchen_basics": NO_BASICS, "inventory": [*inventory(), unrelated]}
    )
    provider = RecordingProvider([assessment("eligible")])
    await assess_meals([recipe], state, provider, deadline=PipelineDeadline(30))

    payload = json.loads(provider.calls[0]["prompt"])
    assert "inventory" not in payload
    [candidate] = payload["candidates"]
    assert sorted(item["name"] for item in candidate["kitchen_items"]) == sorted(
        ingredient.name for ingredient in recipe.ingredients
    )
    assert all(
        item["recipe_names"] == [item["name"]] for item in candidate["kitchen_items"]
    )
    assert provider.calls[0]["thinking"] == "minimal"


@pytest.mark.asyncio
@pytest.mark.parametrize("indices", [[], [0], [0, 0], [-1, 0], [0, 2], [True, 0]])
async def test_incomplete_or_ambiguous_assessments_never_release_recipes(indices):
    recipes = [Recipe.model_validate(case["recipe"]) for case in CASES[:2]]
    response = {"checks": [check(index) for index in indices]}
    with pytest.raises(ProviderError):
        await assess_meals(
            recipes, {"kitchen_basics": NO_BASICS}, FakeProvider([response]),
            deadline=PipelineDeadline(30),
        )


@pytest.mark.asyncio
async def test_reordered_decisions_preserve_original_recipe_order_and_content():
    recipes = [Recipe.model_validate(case["recipe"]) for case in CASES[:2]]
    before = [recipe.model_dump() for recipe in recipes]
    response = assessment("eligible", "eligible")
    response["checks"].reverse()
    result, _, _ = await assess_meals(
        recipes, {"kitchen_basics": NO_BASICS}, FakeProvider([response]),
        deadline=PipelineDeadline(30),
    )
    assert all(actual is original for actual, original in zip(result, recipes))
    assert [recipe.model_dump() for recipe in result] == before


@pytest.mark.asyncio
@pytest.mark.parametrize("response", [ProviderError("offline"), {"checks": None}])
async def test_provider_or_schema_failure_never_releases_unreviewed_recipe(response):
    with pytest.raises(ProviderError):
        await assess_meals(
            [Recipe.model_validate(CASES[0]["recipe"])], {"kitchen_basics": NO_BASICS},
            FakeProvider([response]), deadline=PipelineDeadline(30),
        )


@pytest.mark.asyncio
async def test_assessment_cancellation_propagates():
    class CancelledProvider:
        async def generate(self, *args, **kwargs):
            raise asyncio.CancelledError

    with pytest.raises(asyncio.CancelledError):
        await assess_meals(
            [Recipe.model_validate(CASES[0]["recipe"])], {"kitchen_basics": NO_BASICS},
            CancelledProvider(), deadline=PipelineDeadline(30),
        )


@pytest.mark.asyncio
async def test_assessment_cannot_release_a_response_after_deadline():
    now = [0.0]
    deadline = PipelineDeadline(30, clock=lambda: now[0])

    class LateProvider:
        async def generate(self, *args, **kwargs):
            now[0] = 31.0
            return MealChecklist.model_validate(assessment("eligible"))

    with pytest.raises(ProviderError, match="deadline"):
        await assess_meals(
            [Recipe.model_validate(CASES[0]["recipe"])], {"kitchen_basics": NO_BASICS},
            LateProvider(), deadline=deadline,
        )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("preferences", "dish"),
    [
        ({}, "meal"),
        ({"meal": "Dinner"}, "meal"),
        ({"meal": "Snack"}, "snack"),
        ({"meal": "Dessert"}, "dessert"),
    ],
)
async def test_a_failed_dish_check_names_the_dish_the_cook_asked_for(
    preferences, dish
):
    recipe = Recipe.model_validate(CASES[1]["recipe"])
    provider = RecordingProvider([{"checks": [check(0, "wrong_dish")]}])
    valid, feedback, _ = await assess_meals(
        [recipe], {"kitchen_basics": NO_BASICS, "preferences": preferences}, provider,
        deadline=PipelineDeadline(30),
    )
    assert valid == []
    assert f"wrong_dish: not a {dish} on its own" in feedback
    assert json.loads(provider.calls[0]["prompt"])["requested_dish"] == dish
