"""Photo step that ends a feed graph, so each recipe arrives with its photo."""

from __future__ import annotations

import asyncio
from collections.abc import Mapping
from typing import Any, Protocol

from app.ai.agents.models import Recipe
from app.ai.agents.state import PhotoResult
from app.ai.llm.retry import PipelineDeadline
from app.core.config import settings
from app.models.images import ImageResult

# Time the recipe steps leave for photos at the end of the request deadline.
# A low-quality photo takes about 10 seconds, and a batch's photos run in
# parallel, so one photo's time plus margin covers the batch.
PHOTO_RESERVE_SECONDS = 15.0
# A photo given less time than this would likely time out after it was
# billed, and a billed timeout uses up one of the dish's few attempts. Below
# it the step starts none and every recipe ships with its placeholder.
_MIN_PHOTO_SECONDS = 10.0


class RecipePhotoSource(Protocol):
    """Generates or reuses recipe photos for one requester."""

    def key(self, recipe: Recipe) -> str:
        """Return the photo cache key of `recipe`."""
        ...

    async def photo(self, recipe: Recipe, *, deadline: PipelineDeadline) -> ImageResult:
        """Return the photo of `recipe`, generating it on a miss.

        A generation the call starts must be stored by `deadline`. Failures
        come back as an `unavailable` result, never as an exception.
        """
        ...


async def add_recipe_photos(
    state: Mapping[str, Any],
    photos: RecipePhotoSource,
    *,
    deadline: PipelineDeadline,
) -> PhotoResult:
    """Get a photo for every valid recipe in the batch, all at once.

    Recipes whose titles are in `exclude_titles` are skipped, since the feed
    drops them. Photos run concurrently and must be stored early enough that
    the caller can still make two feed store calls before `deadline`: a
    refill finalizes its batch and then reads the page back. A recipe whose
    photo fails or is over budget gets an `unavailable` placeholder result,
    and one that would not finish in time gets reason `late`. The batch
    itself never fails here, and every generation ends inside the request.

    Args:
        state: Graph state whose `valid_recipes` are photographed.
        photos: The source that generates or reuses each photo.
        deadline: The whole request's deadline, not the recipe steps'.

    Returns:
        `recipe_photos`, mapping each recipe's photo key to its result.
    """
    excluded = {_title_key(title) for title in state.get("exclude_titles", [])}
    recipes = {
        photos.key(recipe): recipe
        for recipe in state.get("valid_recipes", [])
        if _title_key(recipe.title) not in excluded
    }
    photo_deadline = deadline.ending_before(
        2 * settings.recipe_feed_store_timeout_seconds + 1.0
    )
    if photo_deadline.remaining_seconds < _MIN_PHOTO_SECONDS:
        return {
            "recipe_photos": {
                key: ImageResult.unavailable(key, "late") for key in recipes
            }
        }
    results = await asyncio.gather(
        *(
            _photo(photos, key, recipe, photo_deadline)
            for key, recipe in recipes.items()
        )
    )
    return {"recipe_photos": dict(zip(recipes, results, strict=True))}


async def _photo(
    photos: RecipePhotoSource,
    key: str,
    recipe: Recipe,
    deadline: PipelineDeadline,
) -> ImageResult:
    try:
        # The outer limit covers a generation another request started with a
        # later deadline, which this request then shares.
        return await asyncio.wait_for(
            photos.photo(recipe, deadline=deadline),
            timeout=deadline.remaining_seconds,
        )
    except TimeoutError:
        return ImageResult.unavailable(key, "late")


def _title_key(title: str) -> str:
    """Mirror the feed's title comparison in `app.api.recipes`."""
    return " ".join(title.casefold().split())
