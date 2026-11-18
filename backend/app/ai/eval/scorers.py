"""Deterministic recipe quality metrics."""
# ruff: noqa: E501

from __future__ import annotations

import math
from collections.abc import Mapping, Sequence
from decimal import Decimal
from typing import Any

from app.ai.agents.kitchen_basics import KitchenBasics
from app.ai.agents.models import Recipe
from app.inventory.food_facts import FoodLine
from app.inventory.units import Exact, to_stock


def ingredient_coverage_percent(
    recipe: Recipe,
    inventory: Sequence[Mapping[str, Any]],
    kitchen_basics: KitchenBasics,
) -> int:
    """Return the rounded share of recipe ingredients mapped to inventory.

    The recipe API and the eval runner both call this function, so
    the match percentage shown in the mobile feed cannot drift from the
    measured metric. An ingredient mapped to no inventory food counts in the
    denominator but not the numerator. Kitchen basics are always on hand, so
    an ingredient ``kitchen_basics`` supplies is left out of both.
    """
    ingredients = [
        ingredient
        for ingredient in recipe.ingredients
        if not kitchen_basics.supplies(ingredient)
    ]
    total_ingredients = len(ingredients)
    if total_ingredients == 0:
        return 0

    inventory_ids = {
        item_id
        for item in inventory
        if isinstance(item_id := item.get("id"), str) and item_id
    }
    mapped_ingredients = sum(
        ingredient.inventory_item_id in inventory_ids
        for ingredient in ingredients
    )
    return round(mapped_ingredients * 100 / total_ingredients)


def completeness_percent(recipe: Recipe) -> int:
    """Score recipes with usable titles, ingredients, and cooking steps."""
    checks = (
        bool(recipe.title.strip()),
        bool(recipe.ingredients),
        all(item.name.strip() and item.unit.strip() for item in recipe.ingredients),
        bool(recipe.steps) and all(step.instruction for step in recipe.steps),
    )
    return round(sum(checks) * 100 / len(checks))


def mapping_validity_percent(
    recipe: Recipe, usable_items: Sequence[Mapping[str, Any]]
) -> int:
    """Return the percentage of mapped ingredients the cook flow could deduct.

    A mapped ingredient is valid when its food is in ``usable_items``, its
    amount is positive and finite, and the exact amounts of every ingredient
    on that food add up to no more than the food's stock. An approximate,
    small or ask-at-cook amount counts as valid, because the cook flow has
    the cook confirm it. A recipe with no mapped ingredient scores 100.

    Args:
        recipe: The recipe to score, with real food ids.
        usable_items: The pipeline's usable items. Each needs ``id``,
            ``quantity`` in its stock unit, and ``food``, the food's
            ``FoodLine`` fields, for unit conversion.
    """
    by_id = {item["id"]: item for item in usable_items}
    mapped = [item for item in recipe.ingredients if item.inventory_item_id is not None]
    if not mapped:
        return 100
    usable = [
        ingredient.inventory_item_id in by_id
        and ingredient.use_amount is not None
        and math.isfinite(ingredient.use_amount)
        and ingredient.use_amount > 0
        for ingredient in mapped
    ]
    exact_by_id: dict[str, Decimal] = {}
    for ingredient, ok in zip(mapped, usable, strict=True):
        if not ok:
            continue
        food_id = ingredient.inventory_item_id
        facts = FoodLine.model_validate(by_id[food_id]["food"]).facts
        conversion = to_stock(Decimal(str(ingredient.use_amount)), ingredient.unit, facts)
        if isinstance(conversion, Exact):
            exact_by_id[food_id] = exact_by_id.get(food_id, Decimal(0)) + conversion.amount
    over_stock = {
        food_id
        for food_id, needed in exact_by_id.items()
        if needed > Decimal(str(by_id[food_id]["quantity"]))
    }
    valid = sum(
        ok and ingredient.inventory_item_id not in over_stock
        for ingredient, ok in zip(mapped, usable, strict=True)
    )
    return round(valid * 100 / len(mapped))


def embedding_diversity(embeddings: Sequence[Sequence[float]]) -> float:
    """Return mean pairwise cosine distance, deterministic and provider-free."""
    if len(embeddings) < 2:
        return 0.0
    distances: list[float] = []
    for index, left in enumerate(embeddings):
        left_norm = math.sqrt(sum(value * value for value in left))
        for right in embeddings[index + 1 :]:
            right_norm = math.sqrt(sum(value * value for value in right))
            if not left_norm or not right_norm:
                continue
            similarity = sum(a * b for a, b in zip(left, right)) / (left_norm * right_norm)
            distances.append(1 - max(-1.0, min(1.0, similarity)))
    return sum(distances) / len(distances) if distances else 0.0
