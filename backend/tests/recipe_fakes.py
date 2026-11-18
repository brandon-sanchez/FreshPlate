"""Fake provider responses for the recipe pipeline's per-recipe calls."""

from __future__ import annotations

import json
from collections.abc import Iterable, Mapping, Sequence
from typing import Any

from app.ai.agents.food_labels import FoodLabels
from app.ai.agents.kitchen_basics import KitchenBasics
from app.ai.agents.limits import DEFAULT_BATCH_CEILING
from app.ai.agents.meal_quality import MealCheck
from app.ai.agents.nodes import analyze_inventory
from app.ai.llm.providers import FakeProvider, FakeResponse


def batch_responses(
    *recipes: dict[str, Any], calls: int = DEFAULT_BATCH_CEILING
) -> list[dict[str, Any]]:
    """Return the queued FakeProvider answers for one generation batch.

    A batch makes one call per recipe up to its ceiling, so each recipe
    answers one call and each remaining call answers with no recipe.
    """
    if len(recipes) > calls:
        raise ValueError("A batch can't answer with more recipes than calls")
    return [{"recipes": [recipe]} for recipe in recipes] + [{"recipes": []}] * (
        calls - len(recipes)
    )


def model_answer(
    recipe: Mapping[str, Any],
    inventory: Sequence[Mapping[str, Any]],
    basics: KitchenBasics,
) -> dict[str, Any]:
    """Return ``recipe`` as the model writes it, naming foods by prompt label.

    ``recipe`` names foods by their real ids, and ``inventory`` and
    ``basics`` are the kitchen the generation prompt lists. An ingredient
    with no id is a kitchen basic, as ``KitchenBasics.supplies`` reads it,
    and gets the label of the listed basic it names. String steps pass
    through.
    """
    analysis = analyze_inventory({"inventory": inventory, "kitchen_basics": basics})
    labels = FoodLabels(
        (item["id"] for item in analysis["usable_items"]), analysis["kitchen_basics"]
    )

    def ingredient_label(item: Mapping[str, Any]) -> str:
        food_id = item.get("inventory_item_id")
        if food_id is None:
            return labels.basic_label(item["name"])
        return labels.label(food_id)

    return {
        **recipe,
        "ingredients": [
            {**item, "inventory_item_id": ingredient_label(item)}
            for item in recipe["ingredients"]
        ],
        "steps": [
            step
            if isinstance(step, str)
            else {
                **step,
                "uses": [labels.label(food_id) for food_id in step.get("uses", [])],
            }
            for step in recipe["steps"]
        ],
    }


NO_BASICS = KitchenBasics(())


ELIGIBLE: dict[str, Any] = {
    "main_component": "Fixture main component",
    "dish_reasoning": "A meal on its own",
    "portion_reasoning": "A full plate per serving",
    "unlisted_foods": [],
    "is_requested_dish": True,
    "realistic_portions": True,
    "coherent_method": True,
}
"""The judge's checklist for a recipe it keeps."""

WRONG_DISH = {**ELIGIBLE, "is_requested_dish": False}
"""The judge's checklist for a recipe that isn't the requested dish."""


class MealFakeProvider:
    """A fake provider that answers generation and judge calls separately.

    Generation calls take answers from ``generations`` in order. A judge
    call answers from ``judge`` by the judged recipe's title: a list is
    used up in order, one answer per call, and a title with no entry is
    kept with ``ELIGIBLE``. Every call is recorded in ``calls``.
    """

    def __init__(
        self,
        generations: Iterable[FakeResponse] = (),
        judge: Mapping[str, FakeResponse | list[FakeResponse]] | None = None,
    ) -> None:
        self._generations = FakeProvider(generations)
        self._judge = {
            title: list(answers) if isinstance(answers, list) else [answers]
            for title, answers in (judge or {}).items()
        }
        self.calls: list[dict[str, Any]] = []

    @property
    def unused_generations(self) -> int:
        """Return how many queued generation answers no call has used."""
        return self._generations.pending

    @property
    def judged_titles(self) -> list[str]:
        """Return the title of each recipe a judge call saw, in call order."""
        return [
            json.loads(call["prompt"])["recipe"]["title"]
            for call in self.calls
            if call["response_model"] is MealCheck
        ]

    async def generate(self, prompt: str, **kwargs: Any) -> Any:
        self.calls.append({"prompt": prompt, **kwargs})
        if kwargs["response_model"] is not MealCheck:
            return await self._generations.generate(prompt, **kwargs)
        title = json.loads(prompt)["recipe"]["title"]
        answers = self._judge.get(title)
        answer = answers.pop(0) if answers else ELIGIBLE
        return await FakeProvider([answer]).generate(prompt, **kwargs)
