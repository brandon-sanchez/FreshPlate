"""Fake provider responses for the recipe pipeline's per-recipe calls."""

from __future__ import annotations

from typing import Any

from app.ai.agents.limits import DEFAULT_BATCH_CEILING


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
