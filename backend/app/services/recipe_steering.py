"""Resolve a feed page's steering picks into examples for recipe generation."""

from __future__ import annotations

from collections.abc import Sequence
from uuid import UUID

from app.ai.agents.state import RecipeSteering, SteeringExample
from app.models.recipes import RecipeFeedSteering, RecipeSuggestion
from app.services.recipe_feed_store import RecipeFeedSession, RecipeFeedStore


async def resolve_steering(
    store: RecipeFeedStore,
    user_id: str,
    session: RecipeFeedSession,
    steering: RecipeFeedSteering,
) -> RecipeSteering:
    """Look up the steered recipes in the session's own pool.

    Generation sees only recipes this session generated, never recipe text
    from the request. Ids that aren't in the pool are left out, so the result
    can have empty lists. Reads the pool only when the request steers.

    Args:
        store: The feed store, bound to the caller.
        user_id: The caller, who owns ``session``.
        session: The session the page belongs to.
        steering: The page request's picks.

    Raises:
        RecipeFeedStoreError: When the pool can't be read.
    """
    if not (steering.more_like or steering.less_like):
        return {"more_like": [], "less_like": []}
    pool = await store.list_candidates(
        user_id, session.id, start_position=0, limit=session.candidate_count
    )
    by_id = {recipe.recipe_id: recipe for recipe in pool}
    return {
        "more_like": _examples(by_id, steering.more_like),
        "less_like": _examples(by_id, steering.less_like),
    }


def _examples(
    by_id: dict[UUID, RecipeSuggestion], ids: Sequence[UUID]
) -> list[SteeringExample]:
    return [
        {
            "title": recipe.title,
            "foods": [ingredient.name for ingredient in recipe.ingredients],
        }
        for recipe in (by_id.get(recipe_id) for recipe_id in ids)
        if recipe is not None
    ]
