import pytest

from app.ai.agents.kitchen_basics import KitchenBasics
from app.ai.agents.models import Recipe, RecipeGenerationResponse, RecipeIngredient
from app.ai.agents.nodes import analyze_inventory
from app.ai.eval.cases import load_cases
from app.ai.eval.scorers import (
    completeness_percent,
    embedding_diversity,
    ingredient_coverage_percent,
    mapping_validity_percent,
)
from app.ai.llm.providers import FakeProvider
from tests.recipe_fakes import NO_BASICS


def recipe() -> Recipe:
    return Recipe(
        title="Pasta",
        cook_time_minutes=20,
        servings=2,
        ingredients=[
            RecipeIngredient(
                name="tomato", inventory_item_id="t", use_amount=2, unit="each"
            ),
            RecipeIngredient(name="salt", unit="pinch"),
        ],
        steps=["Boil", "Serve"],
    )


TOMATOES = {
    "id": "t",
    "name": "tomato",
    "available": 4,
    "stock_base": "each",
    "each_label": "each",
}
RICE = {"id": "t", "name": "rice", "available": 2000, "stock_base": "g"}
MISO = {
    "id": "m",
    "name": "miso",
    "available": 1,
    "stock_base": "each",
    "each_label": "jar",
}


def kitchen(*lines: dict) -> list:
    return analyze_inventory({"kitchen_basics": NO_BASICS, "inventory": list(lines)})[
        "usable_items"
    ]


def with_ingredients(*ingredients: RecipeIngredient) -> Recipe:
    return recipe().model_copy(update={"ingredients": list(ingredients)})


def test_scorers_score_a_recipe_of_every_dataset_kitchen():
    for case in load_cases():
        inventory = [line.model_dump() for line in case.inventory]
        usable = analyze_inventory(
            {"kitchen_basics": NO_BASICS, "inventory": inventory}
        )["usable_items"]
        mapped = [
            RecipeIngredient(
                name=item["name"],
                inventory_item_id=item["id"],
                use_amount=1,
                unit=item["unit"],
            )
            for item in usable
        ]
        generated = recipe().model_copy(
            update={
                "ingredients": [
                    *mapped,
                    RecipeIngredient(name="olive oil", use_amount=1, unit="tablespoon"),
                ]
            }
        )
        assert ingredient_coverage_percent(generated, usable, NO_BASICS) == 67
        assert (
            ingredient_coverage_percent(
                generated, usable, KitchenBasics(("Olive oil",))
            )
            == 100
        )
        assert mapping_validity_percent(generated, usable) == 100
    assert completeness_percent(recipe()) == 100
    assert mapping_validity_percent(recipe(), kitchen(TOMATOES)) == 100
    assert embedding_diversity([[1, 0], [0, 1]]) == pytest.approx(1)
    assert embedding_diversity([[1, 0], [1, 0]]) == pytest.approx(0)


@pytest.mark.parametrize("amount", [0, -1, 5])
def test_mapping_rejects_invalid_or_over_stock_amounts(amount):
    item = recipe().ingredients[0].model_copy(update={"use_amount": amount})

    assert mapping_validity_percent(with_ingredients(item), kitchen(TOMATOES)) == 0


def test_mapping_partial_and_unknown_id():
    other = RecipeIngredient(
        name="other", inventory_item_id="missing", use_amount=1, unit="each"
    )

    score = mapping_validity_percent(
        with_ingredients(recipe().ingredients[0], other), kitchen(TOMATOES)
    )

    assert score == 50


def test_mapping_counts_a_spoon_of_a_counted_food_as_valid():
    spoon = RecipeIngredient(
        name="miso", inventory_item_id="m", use_amount=2, unit="tbsp"
    )

    assert mapping_validity_percent(with_ingredients(spoon), kitchen(MISO)) == 100


def test_mapping_sums_every_ingredient_on_one_food():
    three = recipe().ingredients[0].model_copy(update={"use_amount": 3})

    score = mapping_validity_percent(with_ingredients(three, three), kitchen(TOMATOES))

    assert score == 0


@pytest.mark.asyncio
async def test_fake_provider_output_scores_through_public_seam():
    provider = FakeProvider([{"recipes": [recipe().model_dump()]}])
    response = await provider.generate("eval", response_model=RecipeGenerationResponse)
    generated = response.recipes[0]
    assert (
        ingredient_coverage_percent(
            generated, [{"id": "t", "quantity": 4}], KitchenBasics(())
        )
        == 50
    )
    assert mapping_validity_percent(generated, kitchen(TOMATOES)) == 100


def test_coverage_leaves_out_unmapped_kitchen_basics():
    soup = recipe().model_copy(
        update={
            "ingredients": [
                RecipeIngredient(
                    name="tomato", inventory_item_id="t", use_amount=2, unit="each"
                ),
                RecipeIngredient(name=" Water ", use_amount=500, unit="ml"),
                RecipeIngredient(name="salt", use_amount=1, unit="tsp"),
            ]
        }
    )
    inventory = [{"id": "t", "quantity": 4}]
    assert (
        ingredient_coverage_percent(soup, inventory, KitchenBasics(("Water", "Salt")))
        == 100
    )
    assert ingredient_coverage_percent(soup, inventory, KitchenBasics(())) == 33


def test_mapping_compares_amounts_in_a_common_unit():
    light = recipe().ingredients[0].model_copy(update={"use_amount": 300, "unit": "g"})
    heavy = light.model_copy(update={"use_amount": 2.5, "unit": "kg"})

    assert mapping_validity_percent(with_ingredients(light), kitchen(RICE)) == 100
    assert mapping_validity_percent(with_ingredients(heavy), kitchen(RICE)) == 0
