"""Behavior tests for reading recipes in both the string-step and cookbook shapes."""

from __future__ import annotations

from typing import Any

from app.ai.agents.models import Recipe, RecipeStep, recipe_batch_model


def _legacy_recipe() -> dict[str, Any]:
    return {
        "title": "Tomato Pasta",
        "cook_time_minutes": 20,
        "servings": 2,
        "ingredients": [
            {
                "name": "Tomatoes",
                "inventory_item_id": "tomatoes",
                "use_amount": 2,
                "unit": "each",
            }
        ],
        "steps": ["Step 1: Boil the pasta\nBoil it until al dente.", "Toss and serve."],
    }


def test_a_recipe_saved_with_string_steps_still_reads() -> None:
    recipe = Recipe.model_validate(_legacy_recipe())

    assert recipe.steps == [
        RecipeStep(instruction="Step 1: Boil the pasta\nBoil it until al dente."),
        RecipeStep(instruction="Toss and serve."),
    ]
    assert recipe.headnote is None
    assert recipe.active_minutes is None
    assert recipe.total_minutes is None
    assert recipe.equipment == []
    assert recipe.ingredients[0].prep is None
    assert recipe.ingredients[0].display_amount is None


def test_a_cookbook_recipe_takes_its_cook_time_from_total_minutes() -> None:
    recipe = Recipe.model_validate(
        {
            "title": "Carrot, Pea and Parmesan Frittata",
            "headnote": "Starts on the stove and finishes under the broiler.",
            "servings": 2,
            "active_minutes": 15,
            "total_minutes": 25,
            "equipment": ["10-inch oven-safe skillet", "box grater"],
            "ingredients": [
                {
                    "name": "Garlic",
                    "inventory_item_id": "garlic",
                    "use_amount": 3,
                    "unit": "clove",
                    "display_amount": "3 cloves",
                    "prep": "minced",
                }
            ],
            "steps": [
                {
                    "instruction": "Soften the vegetables\nCook the garlic for 30 s.",
                    "doneness_cue": "Ready when the garlic smells fragrant.",
                    "minutes": 4,
                    "why": "Garlic goes in last so it doesn't burn.",
                    "uses": ["garlic"],
                }
            ],
        }
    )

    assert recipe.cook_time_minutes == 25
    assert recipe.ingredients[0].display_amount == "3 cloves"
    assert recipe.steps[0].uses == ["garlic"]
    assert recipe.steps[0].minutes == 4


def test_a_zero_or_fractional_time_does_not_reject_the_batch() -> None:
    batch_model = recipe_batch_model(2, {"tomatoes": ["each"]}, extra_units=())
    recipe = {
        **_legacy_recipe(),
        "cook_time_minutes": None,
        "active_minutes": 0,
        "total_minutes": 24.6,
        "steps": [{"instruction": "Plate it.", "minutes": 0, "uses": []}],
    }

    batch = batch_model.model_validate({"recipes": [_legacy_recipe(), recipe]})

    timed = batch.recipes[1]
    assert (timed.active_minutes, timed.total_minutes) == (None, 25)
    assert timed.cook_time_minutes == 25
    assert timed.steps[0].minutes is None


def test_a_step_reads_its_phase_and_treats_a_blank_phase_as_none() -> None:
    steps = [
        RecipeStep.model_validate({"phase": " Rice ", "instruction": "Cook the rice."}),
        RecipeStep.model_validate({"phase": "", "instruction": "Serve."}),
        RecipeStep.model_validate({"instruction": "Toss the pasta."}),
        RecipeStep.model_validate("Step 1: Boil the pasta."),
    ]

    assert [step.phase for step in steps] == ["Rice", None, None, None]


def _schema_keywords(node: Any, keyword: str) -> list[Any]:
    if isinstance(node, dict):
        found = [node[keyword]] if keyword in node else []
        return found + [
            hit for value in node.values() for hit in _schema_keywords(value, keyword)
        ]
    if isinstance(node, list):
        return [hit for value in node for hit in _schema_keywords(value, keyword)]
    return []


def _kitchen(food_count: int) -> dict[str, list[str]]:
    unit_sets = [["g", "kg", "oz", "lb"], ["ml", "l", "cup", "fl oz"], ["each"]]
    return {
        f"00000000-0000-4000-8000-{index:012d}": unit_sets[index % len(unit_sets)]
        for index in range(food_count)
    }


def test_generation_schema_does_not_grow_with_the_number_of_foods() -> None:
    """Gemini answers 400 INVALID_ARGUMENT once the schema lists the food ids."""
    small = recipe_batch_model(5, _kitchen(37), extra_units=()).model_json_schema()
    large = recipe_batch_model(5, _kitchen(300), extra_units=()).model_json_schema()

    assert small == large
    assert _schema_keywords(large, "anyOf") == []
    assert _schema_keywords(large, "enum") == [
        ["g", "kg", "oz", "lb", "ml", "l", "cup", "fl oz", "each"]
    ]


def test_generation_schema_drops_the_unit_enum_past_the_size_gemini_accepted() -> None:
    def unit_enums(unit_count: int) -> list[Any]:
        units = [f"unit{index}" for index in range(unit_count)]
        schema = recipe_batch_model(
            5, {"food": units}, extra_units=()
        ).model_json_schema()
        return _schema_keywords(schema, "enum")

    assert [len(enum) for enum in unit_enums(30)] == [30]
    assert unit_enums(31) == []
