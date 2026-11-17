"""Short labels that stand in for food ids inside one generation request."""

from __future__ import annotations

from collections.abc import Iterable

from app.ai.agents.kitchen_basics import KitchenBasics
from app.ai.agents.models import Recipe


class FoodLabels:
    """The short label of each food and kitchen basic in one generation request.

    The model writes a food's id for every ingredient and every step that
    uses the food, and output length sets a call's latency. The prompt
    therefore names foods ``f1``, ``f2`` and so on, not by their
    36-character ids. Kitchen basics have no id, so the prompt names them
    ``k1``, ``k2`` and so on, which lets every ingredient carry a label in
    one schema shape. Labels follow the order the foods and basics are
    given and mean nothing outside their request, so ``generate_recipes``
    resolves each recipe as soon as its response parses.
    """

    def __init__(self, food_ids: Iterable[str], basics: KitchenBasics) -> None:
        """Label ``food_ids`` from ``f1`` and ``basics`` from ``k1``, in order."""
        self._label_by_id = {
            food_id: f"f{number}" for number, food_id in enumerate(food_ids, start=1)
        }
        self._id_by_label = {
            label: food_id for food_id, label in self._label_by_id.items()
        }
        self._basic_by_label = {
            f"k{number}": name for number, name in enumerate(basics.names, start=1)
        }
        self._label_by_basic = {
            name: label for label, name in self._basic_by_label.items()
        }

    def label(self, food_id: str) -> str:
        """Return the label of ``food_id``, one of the request's foods."""
        return self._label_by_id[food_id]

    def basic_label(self, name: str) -> str:
        """Return the label of ``name``, one of the request's kitchen basics."""
        return self._label_by_basic[name]

    def resolve(self, recipe: Recipe) -> Recipe:
        """Return ``recipe`` with each of the request's labels resolved.

        A food label becomes the food's id. A basic's label becomes a null
        id, which is how ``KitchenBasics.supplies`` recognizes a basic. The
        ingredient keeps the name the model wrote, so the meal judge sees
        "Chicken stock" written on the water's label. Steps drop basic
        labels from ``uses``, because ``uses`` lists food ids. Any other value is kept
        as written, so the quality check rejects an ingredient that names it
        as an unknown food, and drops it from a step's ``uses`` like any
        food the recipe does not list.
        """
        ingredients = [
            item.model_copy(
                update={"inventory_item_id": self._food_id(item.inventory_item_id)}
            )
            for item in recipe.ingredients
        ]
        steps = [
            step.model_copy(
                update={
                    "uses": [
                        self._id_by_label.get(use, use)
                        for use in step.uses
                        if use not in self._basic_by_label
                    ]
                }
            )
            for step in recipe.steps
        ]
        return recipe.model_copy(update={"ingredients": ingredients, "steps": steps})

    def _food_id(self, value: str | None) -> str | None:
        if value is None or value in self._basic_by_label:
            return None
        return self._id_by_label.get(value, value)
