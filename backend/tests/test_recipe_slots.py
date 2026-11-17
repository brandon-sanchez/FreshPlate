"""Behavior of the retry policy that runs a batch's recipe slots."""

from __future__ import annotations

import logging

import pytest

from app.ai.agents.models import Recipe
from app.ai.agents.slots import write_slots
from app.ai.agents.state import RecipeReview
from app.ai.llm.errors import ProviderError

pytestmark = pytest.mark.asyncio


def _recipe(title: str) -> Recipe:
    return Recipe.model_validate(
        {
            "title": title,
            "cook_time_minutes": 20,
            "servings": 2,
            "ingredients": [
                {
                    "name": "Rice",
                    "inventory_item_id": "rice",
                    "use_amount": 200,
                    "unit": "g",
                }
            ],
            "steps": ["Cook the rice."],
        }
    )


class Script:
    """Writes a numbered recipe per call and rejects the titles it is told to."""

    def __init__(self, rejected: set[str], failing: set[str] = frozenset()) -> None:
        self.rejected = rejected
        self.failing = failing
        self.prompts: list[tuple[str, str | None]] = []

    async def write(self, direction: str, feedback: str | None) -> Recipe:
        self.prompts.append((direction, feedback))
        title = f"{direction} {sum(d == direction for d, _ in self.prompts)}"
        if title in self.failing:
            raise ProviderError("offline")
        return _recipe(title)

    async def review(self, recipe: Recipe) -> RecipeReview:
        if recipe.title in self.rejected:
            return RecipeReview(None, f"Recipe '{recipe.title}': wrong_dish")
        return RecipeReview(recipe, None)


async def _run(script: Script, directions: list[str], **policy: object):
    return await write_slots(
        directions,
        write=script.write,
        review=script.review,
        can_retry=lambda: True,
        **policy,
    )


async def test_a_held_back_retry_resumes_the_slot_with_a_truthful_count(caplog):
    script = Script(rejected={"A 1", "A 2", "B 1"})
    caplog.set_level(logging.INFO, logger="freshplate.ai.recipes")

    [a, b] = await _run(
        script, ["A", "B"], quality_retry_limit=2, retry_only_when_no_valid=True
    )

    assert [recipe.title for recipe in a.written] == ["A 1", "A 2", "A 3"]
    assert (a.accepted.title, a.retries) == ("A 3", 2)
    assert (b.accepted.title, b.retries) == ("B 2", 1)
    assert ("A", "Recipe 'A 2': wrong_dish") in script.prompts
    retries_logged = [
        record.recipe_slot["retry"]
        for record in caplog.records
        if hasattr(record, "recipe_slot") and record.recipe_slot["slot"] == 1
    ]
    assert retries_logged == [0, 1, 2]


async def test_held_back_retries_skip_slots_whose_call_failed():
    script = Script(rejected={"A 1"}, failing={"B 1"})

    [a, b] = await _run(
        script, ["A", "B"], quality_retry_limit=1, retry_only_when_no_valid=True
    )

    assert a.accepted.title == "A 2"
    assert b.failure is not None
    assert [direction for direction, _ in script.prompts].count("B") == 1


async def test_a_rejected_slot_retries_at_once_without_waiting_for_others():
    script = Script(rejected={"A 1"})

    [a, b] = await _run(
        script, ["A", "B"], quality_retry_limit=1, retry_only_when_no_valid=False
    )

    assert (a.accepted.title, a.retries) == ("A 2", 1)
    assert (b.accepted.title, b.retries) == ("B 1", 0)


async def test_no_slot_retries_when_the_deadline_leaves_no_room():
    script = Script(rejected={"A 1"})

    [a] = await write_slots(
        ["A"],
        write=script.write,
        review=script.review,
        quality_retry_limit=1,
        retry_only_when_no_valid=False,
        can_retry=lambda: False,
    )

    assert a.accepted is None
    assert a.feedback == "Recipe 'A 1': wrong_dish"


async def test_an_unexpected_error_surfaces_after_every_slot_finishes():
    finished: list[str] = []

    async def write(direction: str, feedback: str | None) -> Recipe:
        if direction == "A":
            raise ValueError("bug")
        finished.append(direction)
        return _recipe(direction)

    with pytest.raises(ValueError, match="bug"):
        await write_slots(
            ["A", "B"],
            write=write,
            review=None,
            quality_retry_limit=0,
            retry_only_when_no_valid=False,
            can_retry=lambda: True,
        )
    assert finished == ["B"]
