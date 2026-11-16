"""Behavior tests for generating a batch as one provider call per recipe."""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from datetime import date
from typing import Any

import pytest

from app.ai.agents.diversity import drop_near_duplicate_titles, recipe_directions
from app.ai.agents.models import Recipe
from app.ai.agents.nodes import (
    MEAL_REVIEW_RESERVE_SECONDS,
    analyze_inventory,
    check_quality,
    generate_recipes,
)
from app.ai.llm.errors import ProviderError
from app.ai.llm.providers import GEMINI_MIN_DEADLINE_SECONDS
from app.ai.llm.retry import PipelineDeadline
from tests.recipe_fakes import NO_BASICS

Behavior = Callable[[int, str], Awaitable[dict[str, Any]]]

FOODS = [
    {
        "id": "salmon",
        "name": "Salmon fillets",
        "available": 4,
        "stock_base": "each",
        "each_label": "fillet",
        "category": "Meat & Seafood",
    },
    {
        "id": "chicken",
        "name": "Chicken thighs",
        "available": 1000,
        "stock_base": "g",
        "category": "Meat & Seafood",
        "next_expiry": "2026-08-05",
    },
    {
        "id": "rice",
        "name": "Jasmine rice",
        "available": 2000,
        "stock_base": "g",
        "category": "Grains & Bread",
    },
    {
        "id": "spinach",
        "name": "Baby spinach",
        "available": 300,
        "stock_base": "g",
        "category": "Produce",
    },
    {
        "id": "soy",
        "name": "Soy sauce",
        "available": 500,
        "stock_base": "ml",
        "category": "Condiments",
    },
]


def _state(**overrides: Any) -> dict[str, Any]:
    analysis = analyze_inventory(
        {"kitchen_basics": NO_BASICS, "inventory": FOODS}, today=date(2026, 8, 3)
    )
    return {
        "kitchen_basics": NO_BASICS,
        "usable_items": analysis["usable_items"],
        "retrieved_recipes": [],
        "preferences": {},
        "exclude_titles": ["Shown Before"],
        "batch_ceiling": 5,
        "retry_count": 0,
        **overrides,
    }


def _recipe(title: str) -> dict[str, Any]:
    return {
        "title": title,
        "servings": 2,
        "total_minutes": 25,
        "ingredients": [
            {
                "name": "Jasmine rice",
                "inventory_item_id": "rice",
                "use_amount": 200,
                "unit": "g",
            }
        ],
        "steps": ["Cook the rice."],
    }


class ScriptedProvider:
    """Answer each generation call by its start order.

    Records every call and the most calls in flight at once, so a test can
    tell concurrent calls from sequential ones.
    """

    def __init__(self, behavior: Behavior) -> None:
        self._behavior = behavior
        self.calls: list[dict[str, Any]] = []
        self._in_flight = 0
        self.max_in_flight = 0

    async def generate(self, prompt: str, **kwargs: Any) -> Any:
        index = len(self.calls)
        self.calls.append({"prompt": prompt, **kwargs})
        self._in_flight += 1
        self.max_in_flight = max(self.max_in_flight, self._in_flight)
        try:
            response = await self._behavior(index, prompt)
        finally:
            self._in_flight -= 1
        return kwargs["response_model"].model_validate(response)


async def _one_recipe_each(index: int, _prompt: str) -> dict[str, Any]:
    await asyncio.sleep(0.01)
    return {"recipes": [_recipe(f"Dish {index}")]}


@pytest.mark.asyncio
async def test_a_batch_sends_one_overlapping_call_per_recipe() -> None:
    provider = ScriptedProvider(_one_recipe_each)

    result = await generate_recipes(_state(), provider)

    assert len(provider.calls) == 5
    assert provider.max_in_flight == 5
    assert [recipe.title for recipe in result["generated_recipes"]] == [
        f"Dish {index}" for index in range(5)
    ]
    for call in provider.calls:
        schema = call["response_model"].model_json_schema()
        assert schema["properties"]["recipes"]["maxItems"] == 1


@pytest.mark.asyncio
async def test_a_failed_call_drops_only_its_recipe() -> None:
    async def third_fails(index: int, prompt: str) -> dict[str, Any]:
        if index == 2:
            raise ProviderError("Gemini generation failed", status_code=500)
        return await _one_recipe_each(index, prompt)

    result = await generate_recipes(_state(), ScriptedProvider(third_fails))

    assert [recipe.title for recipe in result["generated_recipes"]] == [
        "Dish 0",
        "Dish 1",
        "Dish 3",
        "Dish 4",
    ]


@pytest.mark.asyncio
async def test_a_batch_fails_when_every_call_fails() -> None:
    async def always_fails(_index: int, _prompt: str) -> dict[str, Any]:
        raise ProviderError("Gemini generation failed", status_code=503)

    with pytest.raises(ProviderError):
        await generate_recipes(_state(), ScriptedProvider(always_fails))


@pytest.mark.asyncio
async def test_failures_with_only_empty_answers_fail_the_batch() -> None:
    async def first_is_empty(index: int, _prompt: str) -> dict[str, Any]:
        if index == 0:
            return {"recipes": []}
        raise ProviderError("Gemini generation failed", status_code=429)

    with pytest.raises(ProviderError):
        await generate_recipes(_state(), ScriptedProvider(first_is_empty))


@pytest.mark.asyncio
async def test_an_empty_answer_is_a_success_not_a_failure() -> None:
    async def nothing_to_cook(_index: int, _prompt: str) -> dict[str, Any]:
        return {"recipes": []}

    result = await generate_recipes(_state(), ScriptedProvider(nothing_to_cook))

    assert result["generated_recipes"] == []


@pytest.mark.asyncio
async def test_each_call_gets_its_own_direction_after_a_shared_prefix() -> None:
    provider = ScriptedProvider(_one_recipe_each)

    await generate_recipes(_state(), provider)

    prompts = [call["prompt"] for call in provider.calls]
    prefixes = {prompt.split("Direction for this recipe")[0] for prompt in prompts}
    directions = [prompt.split("Direction for this recipe")[1] for prompt in prompts]
    assert len(prefixes) == 1
    assert len(set(directions)) == 5
    assert "Shown Before" in prefixes.pop()
    assert {call["system_instruction"] for call in provider.calls} == {
        provider.calls[0]["system_instruction"]
    }
    schemas = {
        str(call["response_model"].model_json_schema()) for call in provider.calls
    }
    assert len(schemas) == 1


@pytest.mark.asyncio
async def test_directions_lead_with_main_components_and_skip_condiments() -> None:
    provider = ScriptedProvider(_one_recipe_each)

    await generate_recipes(_state(exclude_titles=[]), provider)

    leads = [
        call["prompt"].split("Lead ingredient: ")[1].split(".")[0]
        for call in provider.calls
    ]
    assert leads[:2] == ["Chicken thighs", "Salmon fillets"]
    assert "Soy sauce" not in leads
    assert set(leads[2:4]) == {"Jasmine rice", "Baby spinach"}


@pytest.mark.asyncio
async def test_a_refill_batch_gets_different_directions() -> None:
    first, refill = (
        ScriptedProvider(_one_recipe_each),
        ScriptedProvider(_one_recipe_each),
    )

    await generate_recipes(_state(exclude_titles=[]), first)
    await generate_recipes(
        _state(exclude_titles=[f"Shown {index}" for index in range(5)]), refill
    )

    def directions(provider: ScriptedProvider) -> list[str]:
        return [
            call["prompt"].split("Direction for this recipe")[1]
            for call in provider.calls
        ]

    assert not set(directions(first)) & set(directions(refill))


def _valid(title: str) -> Recipe:
    return Recipe.model_validate(_recipe(title))


def _ungrounded(title: str) -> Recipe:
    recipe = _recipe(title)
    recipe["ingredients"][0]["inventory_item_id"] = "not-in-the-kitchen"
    return Recipe.model_validate(recipe)


def test_the_quality_check_keeps_one_recipe_per_dish() -> None:
    result = check_quality(
        {
            **_state(),
            "generated_recipes": [
                _valid("Garlic Butter Salmon with Rice"),
                _valid("Garlic-Butter Salmon over Rice"),
                _valid("Chicken Fried Rice"),
                _valid("Egg Fried Rice"),
                _valid("Chicken and Fried Rice"),
            ],
        }
    )

    assert [recipe.title for recipe in result["valid_recipes"]] == [
        "Garlic Butter Salmon with Rice",
        "Chicken Fried Rice",
        "Egg Fried Rice",
    ]
    assert result["quality_feedback"] is None


def test_a_rejected_recipe_does_not_hide_its_valid_twin() -> None:
    result = check_quality(
        {
            **_state(),
            "generated_recipes": [
                _ungrounded("Garlic Salmon Rice"),
                _valid("Garlic Salmon with Rice"),
            ],
        }
    )

    assert [recipe.title for recipe in result["valid_recipes"]] == [
        "Garlic Salmon with Rice"
    ]


@pytest.mark.parametrize(
    ("first", "second", "same_dish"),
    [
        ("Lemon Chicken Thighs", "lemon chicken thigh", True),
        ("Beef & Black Bean Stew", "Beef and Black Bean Stew", True),
        ("Salmon Rice", "Salmon Rice Spinach Bowl", False),
        ("Chicken Fried Rice", "Egg Fried Rice", False),
        ("Recipe 11", "Recipe 12", False),
    ],
)
def test_near_duplicate_rule(first: str, second: str, same_dish: bool) -> None:
    kept = drop_near_duplicate_titles([_valid(first), _valid(second)])

    assert [recipe.title for recipe in kept] == (
        [first] if same_dish else [first, second]
    )


def test_a_kitchen_of_only_condiments_still_gets_a_lead() -> None:
    analysis = analyze_inventory(
        {"kitchen_basics": NO_BASICS, "inventory": FOODS[-1:]}, today=date(2026, 8, 3)
    )

    [direction] = recipe_directions(analysis["usable_items"], 1)

    assert "Lead ingredient: Soy sauce." in direction


@pytest.mark.asyncio
async def test_calls_keep_the_full_deadline_when_a_reserve_would_starve_them() -> None:
    provider = ScriptedProvider(_one_recipe_each)
    deadline = PipelineDeadline(
        MEAL_REVIEW_RESERVE_SECONDS + GEMINI_MIN_DEADLINE_SECONDS - 1
    )

    await generate_recipes(_state(), provider, deadline=deadline)

    assert all(call["deadline"] is deadline for call in provider.calls)


@pytest.mark.asyncio
async def test_calls_end_the_meal_review_reserve_before_the_pipeline_deadline() -> None:
    provider = ScriptedProvider(_one_recipe_each)
    deadline = PipelineDeadline(25.0, clock=lambda: 0.0)

    await generate_recipes(_state(), provider, deadline=deadline)

    assert {call["deadline"].remaining_seconds for call in provider.calls} == {
        25.0 - MEAL_REVIEW_RESERVE_SECONDS
    }


SNACK_FOOD = {
    "id": "pretzels",
    "name": "Pretzels",
    "available": 300,
    "stock_base": "g",
    "category": "Snacks",
}


@pytest.mark.asyncio
@pytest.mark.parametrize("preferences", [{}, {"meal": "Dinner"}])
async def test_a_meal_request_asks_every_call_for_a_real_meal(
    preferences: dict[str, str],
) -> None:
    provider = ScriptedProvider(_one_recipe_each)

    await generate_recipes(_state(preferences=preferences), provider)

    for call in provider.calls:
        assert call["prompt"].startswith("Suggest one meal")
        assert "cannot make a real meal, return an empty list" in call["prompt"]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "preferences",
    [{"meal": "Snack"}, {"occasion": "An after-school snack for the kids"}],
)
async def test_a_snack_request_asks_every_call_for_a_real_snack(
    preferences: dict[str, str],
) -> None:
    provider = ScriptedProvider(_one_recipe_each)

    await generate_recipes(_state(preferences=preferences), provider)

    for call in provider.calls:
        prompt = call["prompt"]
        assert "The cook asked for a snack. Suggest one snack" in prompt
        assert "cannot make a real snack, return an empty list" in prompt
        assert "soup, stew" not in prompt
        assert "real meal" not in prompt


def test_snack_directions_may_lead_with_a_snack_food() -> None:
    analysis = analyze_inventory(
        {"kitchen_basics": NO_BASICS, "inventory": [SNACK_FOOD, *FOODS]},
        today=date(2026, 8, 3),
    )

    meal_leads = recipe_directions(analysis["usable_items"], 6)
    snack_leads = recipe_directions(analysis["usable_items"], 6, dish="snack")

    assert not any("Lead ingredient: Pretzels." in d for d in meal_leads)
    assert any("Lead ingredient: Pretzels." in d for d in snack_leads)
    assert all("into a real snack" in d for d in snack_leads)
    assert all("into a real meal" in d for d in meal_leads)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "occasion", ["Dinner, no snacks", "Not a snack, a real dinner", "Without snacks"]
)
async def test_a_request_that_rules_out_snacks_still_asks_for_a_meal(
    occasion: str,
) -> None:
    provider = ScriptedProvider(_one_recipe_each)

    await generate_recipes(_state(preferences={"occasion": occasion}), provider)

    assert all("Suggest one meal" in call["prompt"] for call in provider.calls)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("preferences", "opening"),
    [
        ({"meal": "Dinner", "occasion": "I don't want a snack"}, "Suggest one meal"),
        ({"meal": "Dinner", "occasion": "snack-sized portions"}, "Suggest one meal"),
        ({"meal": "Snack", "occasion": "after a long dinner"}, "The cook asked"),
    ],
)
async def test_the_which_meal_answer_wins_over_the_free_text(
    preferences: dict[str, str], opening: str
) -> None:
    provider = ScriptedProvider(_one_recipe_each)

    await generate_recipes(_state(preferences=preferences), provider)

    assert all(call["prompt"].startswith(opening) for call in provider.calls)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "preferences",
    [
        {"meal": "Dessert"},
        {"occasion": "A dessert for date night"},
        {"occasion": "Something sweet after the movie"},
    ],
)
async def test_a_dessert_request_asks_every_call_for_a_real_dessert(
    preferences: dict[str, str],
) -> None:
    provider = ScriptedProvider(_one_recipe_each)

    await generate_recipes(_state(preferences=preferences), provider)

    for call in provider.calls:
        prompt = call["prompt"]
        assert prompt.startswith("The cook asked for a dessert. Suggest one dessert")
        assert "cannot make a real dessert, return an empty list" in prompt
        assert "soup, stew" not in prompt


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "occasion", ["Dinner, no dessert", "Not a dessert tonight", "Without sweets"]
)
async def test_a_request_that_rules_out_dessert_still_asks_for_a_meal(
    occasion: str,
) -> None:
    provider = ScriptedProvider(_one_recipe_each)

    await generate_recipes(_state(preferences={"occasion": occasion}), provider)

    assert all(call["prompt"].startswith("Suggest one meal") for call in provider.calls)


def test_dessert_directions_never_lead_with_meat() -> None:
    analysis = analyze_inventory(
        {"kitchen_basics": NO_BASICS, "inventory": FOODS}, today=date(2026, 8, 3)
    )

    directions = recipe_directions(analysis["usable_items"], 4, dish="dessert")

    assert not any("Chicken thighs" in d or "Salmon" in d for d in directions)
    assert all("into a real dessert" in d for d in directions)
