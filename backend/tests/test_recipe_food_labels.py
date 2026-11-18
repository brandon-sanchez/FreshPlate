"""Behavior tests for the short food labels recipe generation sends Gemini."""

from __future__ import annotations

import re
from datetime import date
from typing import Any

import pytest

from app.ai.agents.kitchen_basics import KitchenBasics
from app.ai.agents.nodes import analyze_inventory, check_quality, generate_recipes
from tests.recipe_fakes import NO_BASICS

RICE_ID = "4f7c1a52-2a8e-4b8e-9d0c-1f2e3a4b5c6d"
SPINACH_ID = "9b1d6e04-7c3f-4a21-8e5d-6a7b8c9d0e1f"
CHICKEN_ID = "c2e8f3a1-5d4b-4c6e-a7f8-0b1c2d3e4f5a"
FOOD_IDS = (RICE_ID, SPINACH_ID, CHICKEN_ID)

FOODS = [
    {
        "id": RICE_ID,
        "name": "Jasmine rice",
        "available": 2000,
        "stock_base": "g",
        "category": "Grains & Bread",
    },
    {
        "id": SPINACH_ID,
        "name": "Baby spinach",
        "available": 300,
        "stock_base": "g",
        "category": "Produce",
    },
    {
        "id": CHICKEN_ID,
        "name": "Chicken thighs",
        "available": 1000,
        "stock_base": "g",
        "category": "Meat & Seafood",
        "next_expiry": "2026-08-05",
    },
]

_FOOD_LINE = re.compile(r"^- (?P<label>\S+): (?P<name>[^|]+?) \|", re.MULTILINE)


def _state(**overrides: Any) -> dict[str, Any]:
    analysis = analyze_inventory(
        {"kitchen_basics": NO_BASICS, "inventory": FOODS}, today=date(2026, 8, 3)
    )
    return {
        "kitchen_basics": NO_BASICS,
        "usable_items": analysis["usable_items"],
        "retrieved_recipes": [],
        "preferences": {},
        "exclude_titles": [],
        "batch_ceiling": 3,
        **overrides,
    }


def _label_by_name(prompt: str) -> dict[str, str]:
    return {match["name"]: match["label"] for match in _FOOD_LINE.finditer(prompt)}


def _recipe(rice: str, spinach: str) -> dict[str, Any]:
    return {
        "title": "Spinach Rice",
        "servings": 2,
        "total_minutes": 25,
        "ingredients": [
            {
                "name": "Jasmine rice",
                "inventory_item_id": rice,
                "use_amount": 200,
                "unit": "g",
            },
            {
                "name": "Baby spinach",
                "inventory_item_id": spinach,
                "use_amount": 100,
                "unit": "g",
            },
        ],
        "steps": [
            {"instruction": "Cook the rice.", "uses": [rice]},
            {"instruction": "Wilt in the spinach.", "uses": [spinach, rice]},
        ],
    }


class LabelReadingProvider:
    def __init__(self, *, spinach_label: str | None = None) -> None:
        self._spinach_label = spinach_label
        self.prompts: list[str] = []

    async def generate(self, prompt: str, **kwargs: Any) -> Any:
        self.prompts.append(prompt)
        labels = _label_by_name(prompt)
        recipe = _recipe(
            labels["Jasmine rice"], self._spinach_label or labels["Baby spinach"]
        )
        return kwargs["response_model"].model_validate({"recipes": [recipe]})


@pytest.mark.asyncio
async def test_generated_recipes_name_foods_by_their_real_ids() -> None:
    result = await generate_recipes(_state(batch_ceiling=1), LabelReadingProvider())

    [recipe] = result["generated_recipes"]
    assert [item.inventory_item_id for item in recipe.ingredients] == [
        RICE_ID,
        SPINACH_ID,
    ]
    assert [step.uses for step in recipe.steps] == [
        [RICE_ID],
        [SPINACH_ID, RICE_ID],
    ]
    assert check_quality({**_state(), **result})["quality_feedback"] is None


@pytest.mark.asyncio
async def test_the_prompt_labels_foods_expiring_first() -> None:
    provider = LabelReadingProvider()

    await generate_recipes(_state(), provider)

    assert len(provider.prompts) == 3
    for prompt in provider.prompts:
        assert _label_by_name(prompt) == {
            "Chicken thighs": "f1",
            "Jasmine rice": "f2",
            "Baby spinach": "f3",
        }
        assert not any(food_id in prompt for food_id in FOOD_IDS)


@pytest.mark.asyncio
async def test_an_unknown_label_is_rejected_like_an_unknown_food() -> None:
    result = await generate_recipes(
        _state(batch_ceiling=1), LabelReadingProvider(spinach_label="f9")
    )

    quality = check_quality({**_state(), **result})
    assert quality["valid_recipes"] == []
    assert quality["quality_feedback"] == (
        "Recipe 'Spinach Rice': ingredient 'Baby spinach' references missing "
        "inventory id 'f9'"
    )


@pytest.mark.asyncio
async def test_valid_recipes_hold_only_real_food_ids() -> None:
    result = await generate_recipes(_state(), LabelReadingProvider())

    valid = check_quality({**_state(), **result})["valid_recipes"]
    assert len(valid) == 1  # The three calls wrote the same dish.
    named = {item.inventory_item_id for recipe in valid for item in recipe.ingredients}
    used = {food for recipe in valid for step in recipe.steps for food in step.uses}
    assert named | used == {RICE_ID, SPINACH_ID}


class SaltingProvider:
    """Answers with the spinach rice seasoned by the prompt's salt label."""

    async def generate(self, prompt: str, **kwargs: Any) -> Any:
        labels = _label_by_name(prompt)
        [salt] = re.findall(r"^- (k\d+): Salt$", prompt, flags=re.MULTILINE)
        recipe = _recipe(labels["Jasmine rice"], labels["Baby spinach"])
        recipe["ingredients"].append(
            {
                "name": "Flaky sea salt",
                "inventory_item_id": salt,
                "use_amount": 0.5,
                "unit": "tsp",
            }
        )
        recipe["steps"][1]["uses"].append(salt)
        return kwargs["response_model"].model_validate({"recipes": [recipe]})


@pytest.mark.asyncio
async def test_a_basic_label_keeps_the_models_name_with_no_food_id() -> None:
    state = _state(batch_ceiling=1, kitchen_basics=KitchenBasics(["Salt", "Olive oil"]))

    result = await generate_recipes(state, SaltingProvider())

    [recipe] = result["generated_recipes"]
    salt = recipe.ingredients[-1]
    assert (salt.name, salt.inventory_item_id) == ("Flaky sea salt", None)
    assert recipe.steps[1].uses == [SPINACH_ID, RICE_ID]
    assert check_quality({**state, **result})["quality_feedback"] is None
