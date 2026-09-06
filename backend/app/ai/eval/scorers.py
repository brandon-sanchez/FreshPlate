"""Deterministic recipe quality metrics."""
# ruff: noqa: E501

from __future__ import annotations

import math
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


def completeness_percent(recipe: Recipe) -> int:
    """Score recipes with usable titles, ingredients, and cooking steps."""
    checks = (
        bool(recipe.title.strip()),
        bool(recipe.ingredients),
        all(item.name.strip() and item.unit.strip() for item in recipe.ingredients),
        bool(recipe.steps) and all(step.strip() for step in recipe.steps),
    )
    return round(sum(checks) * 100 / len(checks))


def mapping_validity_percent(
    recipe: Recipe, inventory: Sequence[Mapping[str, Any]]
) -> int:
    """Measure mapped ingredients whose IDs and requested amounts are safe."""
    by_id = {
        item["id"]: item
        for item in inventory
        if isinstance(item.get("id"), str) and item.get("id")
    }
    mapped = [item for item in recipe.ingredients if item.inventory_item_id is not None]
    if not mapped:
        return 100
    valid = sum(
        item.inventory_item_id in by_id
        and item.use_amount is not None
        and math.isfinite(item.use_amount)
        and item.use_amount > 0
        and item.use_amount <= float(by_id[item.inventory_item_id].get("quantity", 0))
        for item in mapped
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
