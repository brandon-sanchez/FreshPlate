import json

import pytest

from app.ai.agents.kitchen_basics import KitchenBasics
from app.ai.agents.models import Recipe, RecipeIngredient
from app.ai.eval.judge import judge_recipe
from app.ai.llm.errors import ProviderError
from app.ai.llm.providers import FakeProvider
from app.ai.prompts.loader import load_prompt

PREFERENCES = {"meal": "Dinner", "diet": "Vegan"}
KITCHEN = [{"id": "pasta", "name": "pasta", "quantity": 500, "unit": "g"}]
BASICS = KitchenBasics(("Salt",))


def pasta() -> Recipe:
    return Recipe(
        title="Garlic pasta",
        cook_time_minutes=20,
        servings=2,
        ingredients=[
            RecipeIngredient(
                name="Pasta", inventory_item_id="pasta", use_amount=200, unit="g"
            )
        ],
        steps=["Boil the pasta.", "Serve."],
    )


def check(preference: str, met: bool) -> dict:
    return {"preference": preference, "reasoning": "Reason.", "met": met}


def answer(*checks: dict, violations: list[str] | None = None) -> dict:
    return {
        "preference_checks": list(checks),
        "quantity_reasoning": "Amounts fit two servings.",
        "quantity_violations": violations or [],
    }


class RecordingProvider(FakeProvider):
    def __init__(self, responses):
        super().__init__(responses)
        self.calls: list[dict] = []

    async def generate(self, prompt, **kwargs):
        self.calls.append({"prompt": prompt, **kwargs})
        return await super().generate(prompt, **kwargs)


async def judge(provider, preferences=PREFERENCES):
    return await judge_recipe(
        provider,
        pasta(),
        preferences=preferences,
        kitchen=KITCHEN,
        kitchen_basics=BASICS,
    )


@pytest.mark.asyncio
async def test_alignment_is_the_share_of_stated_preferences_the_recipe_meets():
    result = await judge(
        FakeProvider([answer(check("meal", True), check("diet", False))])
    )

    assert result.preference_alignment == 50
    assert not result.quantity_violations


@pytest.mark.asyncio
async def test_listed_quantity_violations_come_back_with_the_result():
    result = await judge(
        FakeProvider(
            [answer(check("meal", True), check("diet", True), violations=["2 kg salt"])]
        )
    )

    assert result.preference_alignment == 100
    assert result.quantity_violations == ["2 kg salt"]


@pytest.mark.asyncio
async def test_judge_sees_the_recipe_the_answers_and_the_kitchen():
    provider = RecordingProvider([answer(check("meal", True), check("diet", True))])

    await judge(provider)

    call = provider.calls[0]
    payload = json.loads(call["prompt"])
    assert payload["preferences"] == PREFERENCES
    assert payload["kitchen"] == KITCHEN
    assert payload["kitchen_basics"] == ["Salt"]
    assert payload["recipe"]["title"] == "Garlic pasta"
    assert call["system_instruction"] == load_prompt("judge_recipe").system


@pytest.mark.asyncio
async def test_blank_answers_are_not_judged():
    provider = RecordingProvider([answer(check("meal", True))])

    result = await judge(provider, preferences={"meal": "Dinner", "diet": " "})

    assert json.loads(provider.calls[0]["prompt"])["preferences"] == {"meal": "Dinner"}
    assert result.preference_alignment == 100


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "checks",
    [
        [check("meal", True)],
        [check("meal", True), check("diet", True), check("diet", True)],
        [check("meal", True), check("cuisine", True)],
    ],
)
async def test_an_answer_that_skips_repeats_or_invents_a_preference_fails(checks):
    with pytest.raises(ProviderError, match="every stated preference"):
        await judge(FakeProvider([answer(*checks)]))


@pytest.mark.asyncio
async def test_malformed_judge_output_fails():
    with pytest.raises(ProviderError, match="invalid structured output"):
        await judge(FakeProvider([{"preference_alignment": 90}]))


@pytest.mark.asyncio
async def test_with_no_stated_preferences_only_quantities_are_judged():
    result = await judge(FakeProvider([answer()]), preferences={})

    assert result.preference_alignment is None
