"""Recipe photos for feed batches, so every feed card arrives with its photo."""

from __future__ import annotations

import asyncio
from collections.abc import Iterable, Sequence
from typing import Protocol

from app.ai.agents.diversity import drop_near_duplicate_titles, title_key
from app.ai.agents.models import Recipe
from app.ai.llm.retry import PipelineDeadline
from app.core.config import settings
from app.models.images import ImageResult

# Time the recipe steps leave for photos at the end of the request deadline.
# A low-quality photo takes about 10 seconds, and a batch's photos run in
# parallel, so one photo's time plus margin covers the batch.
PHOTO_RESERVE_SECONDS = 15.0
# How many recipes a batch photographs before its request answers. The rest
# of the batch is stored without photos, and the page request that later
# returns them makes their photos, because work left running after a
# response stops when AWS Lambda freezes the instance.
BATCH_PHOTO_LIMIT = 3
# Time a batch's photos leave before the request deadline, so a refill can
# still finalize its batch and read the page back: two feed store calls and
# a second of margin.
_STORE_RESERVE_SECONDS = 2 * settings.recipe_feed_store_timeout_seconds + 1.0
# A photo given less time than this would likely time out after it was
# billed, and a billed timeout uses up one of the dish's few attempts. Below
# it no photo starts, and the recipe ships with its placeholder.
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


class BatchPhotos:
    """Photographs a batch's first kept recipes while the rest are written.

    The writer hands each recipe to `add` as soon as the review keeps it.
    The first `BATCH_PHOTO_LIMIT` that the feed will show get their photos
    started at once, so a slow recipe never holds back the others' photos.
    `done` is set when those photos have finished, which tells the writer it
    can stop waiting for slower recipes.

    A recipe gets no photo when its title is in `exclude_titles`, since the
    feed drops it, or when it repeats the dish of a recipe kept before it,
    since `drop_near_duplicate_titles` drops it. Photos must be stored
    `_STORE_RESERVE_SECONDS` before the request deadline.

    Attributes:
        done: Set once `BATCH_PHOTO_LIMIT` photos have finished. Never set
            when the batch keeps fewer recipes than that.
    """

    def __init__(
        self,
        source: RecipePhotoSource,
        *,
        exclude_titles: Iterable[str],
        deadline: PipelineDeadline,
    ) -> None:
        """Prepare the photos of one batch.

        Args:
            source: Generates or reuses each photo.
            exclude_titles: Titles the feed already showed.
            deadline: The whole request's deadline, not the recipe steps'.
        """
        self._source = source
        self._excluded = {title_key(title) for title in exclude_titles}
        self._deadline = deadline.ending_before(_STORE_RESERVE_SECONDS)
        self._kept: list[Recipe] = []
        self._photos: dict[str, asyncio.Task[ImageResult]] = {}
        self.done = asyncio.Event()

    def add(self, recipe: Recipe) -> None:
        """Start the photo of a kept recipe if it is one of the first shown."""
        if drop_near_duplicate_titles([*self._kept, recipe])[-1] is not recipe:
            return
        self._kept.append(recipe)
        key = self._source.key(recipe)
        if (
            title_key(recipe.title) in self._excluded
            or len(self._photos) >= BATCH_PHOTO_LIMIT
        ):
            return
        task = asyncio.create_task(_photo(self._source, key, recipe, self._deadline))
        task.add_done_callback(self._finished)
        self._photos[key] = task

    async def results(self) -> dict[str, ImageResult]:
        """Wait for every started photo and return them by photo key.

        A failed, over-budget or late photo comes back as an `unavailable`
        placeholder result, never an error.
        """
        try:
            return {key: await task for key, task in self._photos.items()}
        finally:
            self.cancel()

    def cancel(self) -> None:
        """Cancel every started photo, as when the batch failed."""
        for task in self._photos.values():
            task.cancel()

    def _finished(self, _: asyncio.Task[ImageResult]) -> None:
        photos = self._photos.values()
        if len(photos) == BATCH_PHOTO_LIMIT and all(task.done() for task in photos):
            self.done.set()


async def photograph(
    source: RecipePhotoSource,
    recipes: Sequence[Recipe],
    *,
    deadline: PipelineDeadline,
) -> dict[str, ImageResult]:
    """Get the photos of `recipes` at once, generating any that is missing.

    Args:
        source: Generates or reuses each photo.
        recipes: Recipes the backend generated.
        deadline: When every photo must be stored.

    Returns:
        Each recipe's photo by photo key. A failed, over-budget or late photo
        comes back as an `unavailable` placeholder result, never an error.
    """
    keyed = {source.key(recipe): recipe for recipe in recipes}
    results = await asyncio.gather(
        *(_photo(source, key, recipe, deadline) for key, recipe in keyed.items())
    )
    return dict(zip(keyed, results, strict=True))


async def _photo(
    source: RecipePhotoSource,
    key: str,
    recipe: Recipe,
    deadline: PipelineDeadline,
) -> ImageResult:
    if deadline.remaining_seconds < _MIN_PHOTO_SECONDS:
        return ImageResult.unavailable(key, "late")
    try:
        # The outer limit covers a generation another request started with a
        # later deadline, which this request then shares.
        return await asyncio.wait_for(
            source.photo(recipe, deadline=deadline),
            timeout=deadline.remaining_seconds,
        )
    except TimeoutError:
        return ImageResult.unavailable(key, "late")
