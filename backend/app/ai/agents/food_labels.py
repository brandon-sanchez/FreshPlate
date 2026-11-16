"""Short labels that stand in for food ids inside one generation request."""

from __future__ import annotations

from collections.abc import Iterable

from app.ai.agents.models import Recipe


class FoodLabels:
    """The short label of each food in one generation request.

    The model writes a food's id for every ingredient and every step that
    uses the food, and output length sets a call's latency. The prompt
    therefore names foods ``f1``, ``f2`` and so on, not by their
    36-character ids. Labels follow the order the foods are given and mean
    nothing outside their request, so ``generate_recipes`` resolves each
    recipe to real ids as soon as its response parses.
    """

    def __init__(self, food_ids: Iterable[str]) -> None:
        """Label the request's ``food_ids`` in order, starting at ``f1``."""
        self._label_by_id = {
            food_id: f"f{number}" for number, food_id in enumerate(food_ids, start=1)
        }
        self._id_by_label = {
            label: food_id for food_id, label in self._label_by_id.items()
        }

    def label(self, food_id: str) -> str:
        """Return the label of ``food_id``, one of the request's foods."""
        return self._label_by_id[food_id]

    def resolve(self, recipe: Recipe) -> Recipe:
        """Return ``recipe`` with each of the request's labels replaced by its id.

        Any other value is kept as written, so the quality check rejects an
        ingredient that names it as an unknown food, and drops it from a
        step's ``uses`` like any food the recipe does not list.
        """
        ingredients = [
            item.model_copy(
                update={"inventory_item_id": self._food_id(item.inventory_item_id)}
            )
            for item in recipe.ingredients
        ]
        steps = [
            step.model_copy(
                update={"uses": [self._id_by_label.get(use, use) for use in step.uses]}
            )
            for step in recipe.steps
        ]
        return recipe.model_copy(update={"ingredients": ingredients, "steps": steps})

    def _food_id(self, value: str | None) -> str | None:
        return None if value is None else self._id_by_label.get(value, value)
