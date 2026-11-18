"""Enforce meal-review decisions without claiming to test model judgement."""

import asyncio
import json
from pathlib import Path

import pytest

from app.ai.agents.graph import build_recipe_generation_graph, build_recipe_graph
from app.ai.agents.kitchen_basics import KitchenBasics
from app.ai.agents.meal_quality import MealCheck, assess_meal, review_recipe
from app.ai.agents.models import Recipe
from app.ai.agents.nodes import (
    MEAL_REVIEW_RESERVE_SECONDS,
    QUALITY_RETRY_MIN_BUDGET_SECONDS,
    analyze_inventory,
)
from app.ai.llm.errors import ProviderError
from app.ai.llm.retry import PipelineDeadline
from app.inventory.units import table_unit
from tests.recipe_fakes import (
    ELIGIBLE,
    NO_BASICS,
    WRONG_DISH,
    MealFakeProvider,
    model_answer,
)

CASES = json.loads(
    (Path(__file__).parents[1] / "app/ai/eval/meal_fixtures.json").read_text()
)

CHECKLIST_ANSWERS = {
    "eligible": {},
    "wrong_dish": {"is_requested_dish": False},
    "thin_portions": {"realistic_portions": False},
    "incoherent": {"coherent_method": False},
    "unsupported_ingredient": {"unlisted_foods": ["cod"]},
}
RETRY_MARKER = "\n\nQuality feedback from the previous attempt:\n"


def check(answers="eligible"):
    return {**ELIGIBLE, **CHECKLIST_ANSWERS[answers]}


class EmptyRetriever:
    async def search(self, query, **kwargs):
        return []


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
        _food_line(item) for case in CASES[:2] for item in case["recipe"]["ingredients"]
    ]


def _pasta(title):
    """Return the substantial pasta fixture as the model writes it, retitled."""
    return model_answer({**CASES[1]["recipe"], "title": title}, inventory(), NO_BASICS)


def _state(**overrides):
    return {
        **analyze_inventory({"kitchen_basics": NO_BASICS, "inventory": inventory()}),
        **overrides,
    }


def _graph_state(batch_ceiling, **overrides):
    return {
        "kitchen_basics": NO_BASICS,
        "inventory": inventory(),
        "batch_ceiling": batch_ceiling,
        **overrides,
    }


def _titles(recipes):
    return [recipe.title for recipe in recipes]


def _generations(provider):
    return [c for c in provider.calls if c["response_model"] is not MealCheck]


@pytest.mark.asyncio
@pytest.mark.parametrize("case", CASES, ids=lambda case: case["name"])
async def test_curated_meal_decisions_control_returned_recipes(case):
    recipe = Recipe.model_validate(case["recipe"])
    provider = MealFakeProvider(judge={recipe.title: check(case["expected_verdict"])})
    state = {"kitchen_basics": NO_BASICS, "preferences": case.get("preferences", {})}

    verdict, _ = await assess_meal(
        recipe, state, provider, deadline=PipelineDeadline(30)
    )

    assert verdict == case["expected_verdict"]
    payload = json.loads(provider.calls[0]["prompt"])
    assert payload["requested_dish"] == case.get("requested_dish", "meal")


@pytest.mark.asyncio
async def test_each_recipe_is_judged_as_soon_as_its_own_call_returns():
    class LaterCallsWaitForTheFirstJudgement(MealFakeProvider):
        """Holds every generation call but the first until a judge call runs."""

        def __init__(self, generations):
            super().__init__(generations)
            self.judged = asyncio.Event()
            self.generation_calls = 0

        async def generate(self, prompt, **kwargs):
            if kwargs["response_model"] is MealCheck:
                self.judged.set()
            else:
                self.generation_calls += 1
                if self.generation_calls > 1:
                    await asyncio.wait_for(self.judged.wait(), timeout=1)
            return await super().generate(prompt, **kwargs)

    provider = LaterCallsWaitForTheFirstJudgement(
        [
            {"recipes": [_pasta("Quick tomato pasta")]},
            {"recipes": [_pasta("Baked rigatoni")]},
            {"recipes": [_pasta("Garlic noodle bowl")]},
        ]
    )

    result = await build_recipe_graph(provider, EmptyRetriever()).ainvoke(
        _graph_state(3)
    )

    assert provider.judged_titles == [
        "Quick tomato pasta",
        "Baked rigatoni",
        "Garlic noodle bowl",
    ]
    assert len(result["valid_recipes"]) == 3


@pytest.mark.asyncio
@pytest.mark.parametrize("refill", [False, True])
async def test_a_rejected_recipe_is_rewritten_alone_under_one_deadline(refill):
    provider = MealFakeProvider(
        [
            {"recipes": [_pasta("Tomato pasta")]},
            {"recipes": [_pasta("Plain garlic noodles")]},
            {"recipes": [_pasta("Baked rigatoni")]},
            {"recipes": [_pasta("Garlic chickpea pasta")]},
        ],
        judge={"Plain garlic noodles": WRONG_DISH},
    )
    state = _graph_state(3, metadata={"trace_key": "keep"})
    if refill:
        state.update(analyze_inventory(state))
        graph = build_recipe_generation_graph(provider)
    else:
        graph = build_recipe_graph(provider, EmptyRetriever())

    result = await graph.ainvoke(state)

    assert sorted(_titles(result["valid_recipes"])) == [
        "Baked rigatoni",
        "Garlic chickpea pasta",
        "Tomato pasta",
    ]
    assert result["retry_count"] == 1
    assert result["quality_feedback"] is None
    generations = _generations(provider)
    assert len(generations) == 4
    [retry] = [call for call in generations if RETRY_MARKER in call["prompt"]]
    first_try, feedback = retry["prompt"].split(RETRY_MARKER)
    assert first_try in [call["prompt"] for call in generations]
    assert feedback.startswith(
        "Recipe 'Plain garlic noodles': wrong_dish: not a meal on its own"
    )
    judge_calls = [c for c in provider.calls if c["response_model"] is MealCheck]
    assert len(judge_calls) == 4
    assert all(call["deadline"] is result["deadline"] for call in judge_calls)
    review_end = result["deadline"].remaining_seconds - MEAL_REVIEW_RESERVE_SECONDS
    assert all(
        abs(call["deadline"].remaining_seconds - review_end) < 0.5
        for call in generations
    )
    assert result["metadata"]["trace_key"] == "keep"
    assert result["metadata"]["assessment_prompt_version"] == 5


@pytest.mark.asyncio
async def test_a_feed_batch_with_a_kept_recipe_rewrites_nothing():
    provider = MealFakeProvider(
        [
            {"recipes": [_pasta("Tomato pasta")]},
            {"recipes": [_pasta("Plain garlic noodles")]},
        ],
        judge={"Plain garlic noodles": WRONG_DISH},
    )
    graph = build_recipe_graph(
        provider, EmptyRetriever(), retry_only_when_no_valid=True
    )

    result = await graph.ainvoke(_graph_state(2))

    assert _titles(result["valid_recipes"]) == ["Tomato pasta"]
    assert result["retry_count"] == 0
    assert "Plain garlic noodles" in result["quality_feedback"]
    assert len(provider.calls) == 4


@pytest.mark.asyncio
async def test_a_feed_batch_that_kept_nothing_rewrites_each_rejected_recipe():
    provider = MealFakeProvider(
        [
            {"recipes": [_pasta("Garlic noodles")]},
            {"recipes": []},
            {"recipes": [_pasta("Tomato pasta")]},
        ],
        judge={"Garlic noodles": WRONG_DISH},
    )
    graph = build_recipe_graph(
        provider, EmptyRetriever(), retry_only_when_no_valid=True
    )

    result = await graph.ainvoke(_graph_state(2))

    assert _titles(result["valid_recipes"]) == ["Tomato pasta"]
    assert result["retry_count"] == 1
    generations = _generations(provider)
    assert len(generations) == 3
    assert "Recipe 'Garlic noodles'" in generations[2]["prompt"]


@pytest.mark.asyncio
async def test_rejected_meals_exhaust_their_retry_and_return_empty():
    provider = MealFakeProvider(
        [{"recipes": [_pasta("Garlic noodles")]}] * 2,
        judge={"Garlic noodles": [WRONG_DISH, WRONG_DISH]},
    )

    result = await build_recipe_graph(provider, EmptyRetriever()).ainvoke(
        _graph_state(1)
    )

    assert result["valid_recipes"] == []
    assert result["retry_count"] == 1
    assert len(provider.calls) == 4
    assert "wrong_dish" in result["quality_feedback"]


@pytest.mark.asyncio
async def test_no_rewrite_starts_without_time_for_its_call_and_review():
    provider = MealFakeProvider(
        [{"recipes": [_pasta("Garlic noodles")]}],
        judge={"Garlic noodles": WRONG_DISH},
    )
    deadline = PipelineDeadline(QUALITY_RETRY_MIN_BUDGET_SECONDS - 1)

    result = await build_recipe_graph(provider, EmptyRetriever()).ainvoke(
        _graph_state(1, deadline=deadline)
    )

    assert result["valid_recipes"] == []
    assert result["retry_count"] == 0
    assert len(provider.calls) == 2


@pytest.mark.asyncio
async def test_a_failed_judge_call_drops_only_its_recipe():
    provider = MealFakeProvider(
        [
            {"recipes": [_pasta("Tomato pasta")]},
            {"recipes": [_pasta("Garlic noodles")]},
        ],
        judge={"Garlic noodles": ProviderError("offline")},
    )

    result = await build_recipe_graph(provider, EmptyRetriever()).ainvoke(
        _graph_state(2)
    )

    assert _titles(result["valid_recipes"]) == ["Tomato pasta"]


@pytest.mark.asyncio
@pytest.mark.parametrize("response", [ProviderError("offline"), {"checks": []}])
async def test_a_batch_whose_judge_never_answers_fails_rather_than_reading_empty(
    response,
):
    provider = MealFakeProvider(
        [{"recipes": [_pasta("Garlic noodles")]}],
        judge={"Garlic noodles": response},
    )

    with pytest.raises(ProviderError):
        await build_recipe_graph(provider, EmptyRetriever()).ainvoke(_graph_state(1))


@pytest.mark.asyncio
async def test_an_empty_batch_with_a_failed_call_is_an_outage_not_an_empty_kitchen():
    provider = MealFakeProvider(
        [{"recipes": [_pasta("Garlic noodles")]}, ProviderError("timeout")],
        judge={"Garlic noodles": WRONG_DISH},
    )
    graph = build_recipe_graph(provider, EmptyRetriever(), quality_retry_limit=0)

    with pytest.raises(ProviderError):
        await graph.ainvoke(_graph_state(2))


@pytest.mark.asyncio
async def test_invalid_inventory_skips_the_judge():
    recipe = Recipe.model_validate(CASES[0]["recipe"])
    provider = MealFakeProvider()

    review = await review_recipe(
        recipe, _state(usable_items=[]), provider, deadline=PipelineDeadline(30)
    )

    assert review.recipe is None
    assert "missing inventory" in review.feedback
    assert provider.calls == []


GRAM_KITCHEN = [
    {
        "id": "chicken",
        "name": "Chicken thighs",
        "available": 2000,
        "stock_base": "g",
        "category": "Meat & Seafood",
    },
    {
        "id": "parsley",
        "name": "Parsley",
        "available": 500,
        "stock_base": "g",
        "category": "Produce",
    },
]


def _gram_recipe(*ingredients):
    return Recipe.model_validate(
        {
            "title": "Fixture dish",
            "cook_time_minutes": 20,
            "servings": 2,
            "ingredients": [
                {
                    "name": name,
                    "inventory_item_id": food,
                    "use_amount": grams,
                    "unit": "g",
                }
                for food, name, grams in ingredients
            ],
            "steps": ["Cook it."],
        }
    )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("ingredients", "verdict"),
    [
        ([("parsley", "Parsley", 60)], "wrong_dish: no main component"),
        ([("chicken", "Chicken thighs", 150)], "insufficient: about 75 g"),
    ],
    ids=["no main component", "under-portioned"],
)
async def test_code_rejects_a_clear_non_meal_without_a_judge_call(ingredients, verdict):
    provider = MealFakeProvider()
    state = analyze_inventory({"kitchen_basics": NO_BASICS, "inventory": GRAM_KITCHEN})

    review = await review_recipe(
        _gram_recipe(*ingredients), state, provider, deadline=PipelineDeadline(30)
    )

    assert review.recipe is None
    assert f"Recipe 'Fixture dish': {verdict}" in review.feedback
    assert provider.calls == []


@pytest.mark.asyncio
async def test_a_full_portion_goes_on_to_the_judge():
    provider = MealFakeProvider()
    state = analyze_inventory({"kitchen_basics": NO_BASICS, "inventory": GRAM_KITCHEN})

    review = await review_recipe(
        _gram_recipe(("chicken", "Chicken thighs", 400)),
        state,
        provider,
        deadline=PipelineDeadline(30),
    )

    assert review.recipe is not None
    assert provider.judged_titles == ["Fixture dish"]


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
    provider = MealFakeProvider(judge={recipe.title: check(answers)})

    review = await review_recipe(
        recipe, _state(), provider, deadline=PipelineDeadline(30)
    )

    assert review.recipe is None
    assert review.feedback.startswith(f"Recipe '{recipe.title}': {verdict}")


@pytest.mark.asyncio
async def test_the_judge_catches_a_food_written_on_a_basics_label():
    basics = KitchenBasics(["Salt", "Water"])
    pasta = CASES[1]["recipe"]
    water = {
        "name": "Water",
        "inventory_item_id": None,
        "use_amount": 250,
        "unit": "ml",
    }
    answer = model_answer(
        {**pasta, "ingredients": [*pasta["ingredients"], water]}, inventory(), basics
    )
    answer["ingredients"][-1]["name"] = "Chicken stock"
    provider = MealFakeProvider(
        [{"recipes": [answer]}],
        judge={pasta["title"]: {**ELIGIBLE, "unlisted_foods": ["Chicken stock"]}},
    )
    state = {"kitchen_basics": basics, "inventory": inventory(), "batch_ceiling": 1}

    result = await build_recipe_graph(
        provider, EmptyRetriever(), quality_retry_limit=0
    ).ainvoke(state)

    payload = json.loads(provider.calls[1]["prompt"])
    assert {"name": "Chicken stock", "inventory_item_id": None}.items() <= next(
        item
        for item in payload["recipe"]["ingredients"]
        if item["name"] == "Chicken stock"
    ).items()
    assert result["valid_recipes"] == []
    assert "Chicken stock" in result["quality_feedback"]


@pytest.mark.asyncio
async def test_kitchen_basics_are_never_unlisted_foods():
    recipe = Recipe.model_validate(CASES[1]["recipe"])
    provider = MealFakeProvider(
        judge={recipe.title: {**ELIGIBLE, "unlisted_foods": [" salt ", "Water"]}}
    )

    verdict, _ = await assess_meal(
        recipe,
        {"kitchen_basics": KitchenBasics(["Salt", "Water"])},
        provider,
        deadline=PipelineDeadline(30),
    )

    assert verdict == "eligible"
    assert json.loads(provider.calls[0]["prompt"])["kitchen_basics"] == [
        "Salt",
        "Water",
    ]


@pytest.mark.asyncio
async def test_water_is_unlisted_when_the_household_has_no_such_basic():
    recipe = Recipe.model_validate(CASES[1]["recipe"])
    provider = MealFakeProvider(
        judge={recipe.title: {**ELIGIBLE, "unlisted_foods": ["Water"]}}
    )

    verdict, _ = await assess_meal(
        recipe,
        {"kitchen_basics": NO_BASICS},
        provider,
        deadline=PipelineDeadline(30),
    )

    assert verdict == "unsupported_ingredient"


@pytest.mark.asyncio
async def test_judge_sees_only_its_recipes_inventory_items_at_minimal_thinking():
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
    provider = MealFakeProvider()

    await assess_meal(recipe, state, provider, deadline=PipelineDeadline(30))

    payload = json.loads(provider.calls[0]["prompt"])
    assert "inventory" not in payload
    assert payload["recipe"]["title"] == recipe.title
    assert sorted(item["name"] for item in payload["kitchen_items"]) == sorted(
        ingredient.name for ingredient in recipe.ingredients
    )
    assert all(
        item["recipe_names"] == [item["name"]] for item in payload["kitchen_items"]
    )
    assert provider.calls[0]["thinking"] == "minimal"


@pytest.mark.asyncio
@pytest.mark.parametrize("response", [ProviderError("offline"), {"checks": None}])
async def test_provider_or_schema_failure_never_releases_unreviewed_recipe(response):
    recipe = Recipe.model_validate(CASES[1]["recipe"])
    with pytest.raises(ProviderError):
        await review_recipe(
            recipe,
            _state(),
            MealFakeProvider(judge={recipe.title: response}),
            deadline=PipelineDeadline(30),
        )


@pytest.mark.asyncio
async def test_assessment_cancellation_propagates():
    class CancelledProvider:
        async def generate(self, *args, **kwargs):
            raise asyncio.CancelledError

    with pytest.raises(asyncio.CancelledError):
        await assess_meal(
            Recipe.model_validate(CASES[0]["recipe"]),
            {"kitchen_basics": NO_BASICS},
            CancelledProvider(),
            deadline=PipelineDeadline(30),
        )


@pytest.mark.asyncio
async def test_assessment_cannot_release_a_response_after_deadline():
    now = [0.0]
    deadline = PipelineDeadline(30, clock=lambda: now[0])

    class LateProvider:
        async def generate(self, *args, **kwargs):
            now[0] = 31.0
            return MealCheck.model_validate(ELIGIBLE)

    with pytest.raises(ProviderError, match="deadline"):
        await assess_meal(
            Recipe.model_validate(CASES[0]["recipe"]),
            {"kitchen_basics": NO_BASICS},
            LateProvider(),
            deadline=deadline,
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
async def test_a_failed_dish_check_names_the_dish_the_cook_asked_for(preferences, dish):
    recipe = Recipe.model_validate(CASES[1]["recipe"])
    provider = MealFakeProvider(judge={recipe.title: WRONG_DISH})

    verdict, reason = await assess_meal(
        recipe,
        {"kitchen_basics": NO_BASICS, "preferences": preferences},
        provider,
        deadline=PipelineDeadline(30),
    )

    assert verdict == "wrong_dish"
    assert reason.startswith(f"not a {dish} on its own")
    assert json.loads(provider.calls[0]["prompt"])["requested_dish"] == dish
