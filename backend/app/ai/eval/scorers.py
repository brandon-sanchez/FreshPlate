"""Deterministic recipe quality metrics."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any

from app.ai.agents.models import Recipe


def ingredient_coverage_percent(
    recipe: Recipe,
    inventory: Sequence[Mapping[str, Any]],
) -> int:
    """Return the rounded share of recipe ingredients mapped to inventory.

    The API and the future eval runner call this same function so the match
    percentage shown in the mobile feed cannot drift from the measured metric.
    Untracked staples count in the denominator but not the numerator.
    """
    total_ingredients = len(recipe.ingredients)
    if total_ingredients == 0:
        return 0

    inventory_ids = {
        item_id
        for item in inventory
        if isinstance(item_id := item.get("id"), str) and item_id
    }
    mapped_ingredients = sum(
        ingredient.inventory_item_id in inventory_ids
        for ingredient in recipe.ingredients
    )
    return round(mapped_ingredients * 100 / total_ingredients)
