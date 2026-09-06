# ruff: noqa: E501
import json
from pathlib import Path

import pytest

from app.ai.agents.models import Recipe, RecipeGenerationResponse, RecipeIngredient
from app.ai.agents.nodes import analyze_inventory
from app.ai.eval.scorers import (
    completeness_percent,
    embedding_diversity,
    ingredient_coverage_percent,
    mapping_validity_percent,
)
from app.ai.llm.providers import FakeProvider


def recipe() -> Recipe:
    return Recipe(
        title="Pasta",
        cook_time_minutes=20,
        servings=2,
        ingredients=[
            RecipeIngredient(name="tomato", inventory_item_id="t", use_amount=2, unit="each"),
            RecipeIngredient(name="salt", unit="pinch"),
        ],
        steps=["Boil", "Serve"],
    )


def test_scorers_and_curated_dataset_contract():
    cases = json.loads((Path(__file__).parents[1] / "app/ai/eval/dataset.json").read_text())
    assert len(cases) == 22
    assert all(all("name" in item and "quantity" in item and "unit" in item for item in case["inventory"]) for case in cases)
    for case in cases:
        usable = analyze_inventory({"inventory": case["inventory"]})["usable_items"]
        generated = recipe().model_copy(update={"ingredients": [RecipeIngredient(name=usable[0]["name"], inventory_item_id=usable[0]["id"], use_amount=1, unit=usable[0]["unit"])]})
        assert case["expected_coverage"][0] <= ingredient_coverage_percent(generated, usable) <= case["expected_coverage"][1]
    assert completeness_percent(recipe()) == 100
    assert mapping_validity_percent(recipe(), [{"id": "t", "quantity": 4}]) == 100
    assert embedding_diversity([[1, 0], [0, 1]]) == pytest.approx(1)
    assert embedding_diversity([[1, 0], [1, 0]]) == pytest.approx(0)


@pytest.mark.parametrize("amount", [0, -1, 5])
def test_mapping_rejects_invalid_amounts(amount):
    item = recipe().ingredients[0].model_copy(update={"use_amount": amount})
    assert mapping_validity_percent(recipe().model_copy(update={"ingredients": [item]}), [{"id": "t", "quantity": 4}]) == 0


def test_mapping_partial_and_unknown_id():
    ingredients = [recipe().ingredients[0], RecipeIngredient(name="other", inventory_item_id="missing", use_amount=1, unit="each")]
    assert mapping_validity_percent(recipe().model_copy(update={"ingredients": ingredients}), [{"id": "t", "quantity": 4}]) == 50


@pytest.mark.asyncio
async def test_fake_provider_output_scores_through_public_seam():
    provider = FakeProvider([{"recipes": [recipe().model_dump()]}])
    response = await provider.generate("eval", response_model=RecipeGenerationResponse)
    generated = response.recipes[0]
    assert ingredient_coverage_percent(generated, [{"id": "t", "quantity": 4}]) == 50
    assert mapping_validity_percent(generated, [{"id": "t", "quantity": 4}]) == 100
