"""Fake provider responses for the recipe pipeline's per-recipe calls."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any

from app.ai.agents.food_labels import FoodLabels
from app.ai.agents.limits import DEFAULT_BATCH_CEILING
from app.ai.agents.nodes import analyze_inventory


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
) -> dict[str, Any]:
    """Return ``recipe`` as the model writes it, naming foods by prompt label.

    ``recipe`` names foods by their real ids, and ``inventory`` is the
    kitchen the generation prompt lists. String steps pass through.
    """
    usable = analyze_inventory({"inventory": inventory})["usable_items"]
    labels = FoodLabels(item["id"] for item in usable)

    def label(food_id: str | None) -> str | None:
        return None if food_id is None else labels.label(food_id)

    return {
        **recipe,
        "ingredients": [
            {**item, "inventory_item_id": label(item.get("inventory_item_id"))}
            for item in recipe["ingredients"]
        ],
        "steps": [
            step
            if isinstance(step, str)
            else {**step, "uses": [label(food_id) for food_id in step.get("uses", [])]}
            for step in recipe["steps"]
        ],
    }
