"""Behavior of the photos a recipe graph takes for each feed batch."""

from __future__ import annotations

import asyncio
import time
from datetime import date
from typing import Any

import pytest

from app.ai.agents.graph import build_recipe_generation_graph, build_recipe_graph
from app.ai.agents.meal_quality import MealCheck
from app.ai.agents.models import Recipe
from app.ai.agents.nodes import MEAL_REVIEW_RESERVE_SECONDS, analyze_inventory
from app.ai.agents.photos import PHOTO_RESERVE_SECONDS, photograph
from app.ai.llm.providers import GEMINI_MIN_DEADLINE_SECONDS
from app.ai.llm.retry import PipelineDeadline
from app.ai.rag.vector_store import RetrievedRecipe
from app.core.config import settings
from app.models.images import ImageResult
from app.services.image_service import ImageService, RequesterRecipePhotos
from tests.image_fakes import POLICY, FakeStore
from tests.image_fakes import FakeProvider as FakeImageProvider
from tests.recipe_fakes import NO_BASICS, MealFakeProvider, batch_responses

pytestmark = pytest.mark.asyncio

USER = "00000000-0000-0000-0000-000000000001"
TOMATOES = {
    "id": "tomatoes",
    "name": "Tomatoes",
    "available": 6,
    "next_expiry": "2026-08-08",
    "stock_base": "each",
    "each_label": "each",
}


def _recipe(title: str, *, grounded: bool = True) -> dict[str, Any]:
    return {
        "title": title,
        "cook_time_minutes": 20,
        "servings": 2,
        "ingredients": [
            {
                "name": "Tomatoes" if grounded else "Saffron",
                "inventory_item_id": "tomatoes" if grounded else None,
                "use_amount": 2,
                "unit": "each",
            }
        ],
        "steps": ["Cook the tomatoes."],
    }




class Clock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


class ClockedProvider:
    """Answers from a queue, then moves the clock as if each call took time."""

    def __init__(
        self, responses: list[Any], clock: Clock, durations: list[float]
    ) -> None:
        self._inner = MealFakeProvider(responses)
        self._clock = clock
        self._durations = list(durations)
        self.remaining_at_call: list[float] = []

    async def generate(self, prompt: str, **kwargs: Any) -> Any:
        self.remaining_at_call.append(kwargs["deadline"].remaining_seconds)
        response = await self._inner.generate(prompt, **kwargs)
        self._clock.now += self._durations.pop(0) if self._durations else 0
        return response


class RecordingPhotos:
    def __init__(self, delay: float = 0.05, fail: set[str] = frozenset()) -> None:
        self.delay = delay
        self.fail = fail
        self.titles: list[str] = []
        self.timeouts: list[float] = []
        self.active = 0
        self.max_active = 0

    def key(self, recipe: Recipe) -> str:
        return ImageService.recipe_key(recipe)

    async def photo(self, recipe: Recipe, *, deadline: PipelineDeadline) -> ImageResult:
        self.titles.append(recipe.title)
        self.timeouts.append(deadline.remaining_seconds)
        self.active += 1
        self.max_active = max(self.max_active, self.active)
        await asyncio.sleep(self.delay)
        self.active -= 1
        key = self.key(recipe)
        if recipe.title in self.fail:
            return ImageResult.unavailable(key, "failed")
        return ImageResult(status="ready", image_key=key, url=f"https://cdn/{key}")


def _refill_state(deadline: PipelineDeadline) -> dict[str, Any]:
    analysis = analyze_inventory(
        {"kitchen_basics": NO_BASICS, "inventory": [TOMATOES]}, today=date(2026, 8, 3)
    )
    return {
        "kitchen_basics": NO_BASICS,
        "usable_items": analysis["usable_items"],
        "retrieved_recipes": [],
        "preferences": {},
        "exclude_titles": [],
        "batch_ceiling": 5,
        "metadata": {},
        "deadline": deadline,
    }


def _photo_of(result: dict[str, Any], title: str) -> ImageResult:
    [recipe] = [r for r in result["valid_recipes"] if r.title == title]
    return result["recipe_photos"][ImageService.recipe_key(recipe)]


async def test_refill_photographs_every_valid_recipe_concurrently():
    photos = RecordingPhotos()
    provider = MealFakeProvider(
        [
            *batch_responses(
                _recipe("Roast tomatoes"),
                _recipe("Saffron rice", grounded=False),
                _recipe("Tomato soup"),
            ),
        ]
    )
    graph = build_recipe_generation_graph(
        provider, photos=photos, quality_retry_limit=0
    )

    result = await graph.ainvoke(_refill_state(PipelineDeadline(45)))

    assert sorted(photos.titles) == ["Roast tomatoes", "Tomato soup"]
    assert photos.max_active == 2
    assert _photo_of(result, "Tomato soup").status == "ready"


async def test_first_session_graph_also_ends_with_photos():
    photos = RecordingPhotos()
    retriever = _Retriever()
    provider = MealFakeProvider(
        [*batch_responses(_recipe("Roast tomatoes"))]
    )
    graph = build_recipe_graph(provider, retriever, photos=photos)

    result = await graph.ainvoke(
        {
            "kitchen_basics": NO_BASICS,
            "inventory": [TOMATOES],
            "batch_ceiling": 5,
            "deadline": PipelineDeadline(45),
        }
    )

    assert photos.titles == ["Roast tomatoes"]
    assert _photo_of(result, "Roast tomatoes").status == "ready"


async def test_a_failed_photo_ships_its_recipe_with_a_placeholder():
    photos = RecordingPhotos(fail={"Tomato soup"})
    provider = MealFakeProvider(
        [
            *batch_responses(_recipe("Roast tomatoes"), _recipe("Tomato soup")),
        ]
    )
    graph = build_recipe_generation_graph(provider, photos=photos)

    result = await graph.ainvoke(_refill_state(PipelineDeadline(45)))

    assert [r.title for r in result["valid_recipes"]] == [
        "Roast tomatoes",
        "Tomato soup",
    ]
    failed = _photo_of(result, "Tomato soup")
    assert failed.status == "unavailable" and failed.reason == "failed"
    assert _photo_of(result, "Roast tomatoes").status == "ready"


async def test_an_exhausted_budget_ships_recipes_with_placeholders():
    images = ImageService(FakeStore(spent=100), FakeImageProvider(), POLICY)
    photos = RequesterRecipePhotos(images, USER)
    provider = MealFakeProvider(
        [*batch_responses(_recipe("Roast tomatoes"))]
    )
    graph = build_recipe_generation_graph(provider, photos=photos)

    result = await graph.ainvoke(_refill_state(PipelineDeadline(45)))

    photo = _photo_of(result, "Roast tomatoes")
    assert photo.status == "unavailable" and photo.reason == "budget_exhausted"


async def test_a_store_outage_ships_recipes_with_placeholders():
    store = FakeStore()
    store.fail_upload = True
    images = ImageService(store, FakeImageProvider(), POLICY)
    provider = MealFakeProvider(
        [*batch_responses(_recipe("Roast tomatoes"))]
    )
    graph = build_recipe_generation_graph(
        provider, photos=RequesterRecipePhotos(images, USER)
    )

    result = await graph.ainvoke(_refill_state(PipelineDeadline(45)))

    photo = _photo_of(result, "Roast tomatoes")
    assert photo.status == "unavailable" and photo.reason == "failed"


async def test_recipe_steps_leave_the_photo_reserve_untouched():
    clock = Clock()
    photos = RecordingPhotos(delay=0)
    provider = ClockedProvider(
        [*batch_responses(_recipe("Roast tomatoes"))],
        clock,
        # The fake answers calls one at a time, so only the batch's last
        # call moves the clock, as if all five overlapped for 20 seconds.
        durations=[0, 0, 0, 0, 20],
    )
    graph = build_recipe_generation_graph(provider, photos=photos)

    await graph.ainvoke(_refill_state(PipelineDeadline(45, clock=clock)))

    assert provider.remaining_at_call[0] == pytest.approx(
        45 - PHOTO_RESERVE_SECONDS - MEAL_REVIEW_RESERVE_SECONDS
    )
    generation = 20
    two_store_calls = 2 * settings.recipe_feed_store_timeout_seconds + 1
    assert photos.timeouts == [pytest.approx(45 - generation - two_store_calls)]


async def test_no_photo_starts_when_the_deadline_leaves_no_time_for_one():
    photos = RecordingPhotos(delay=0)
    dish = Recipe.model_validate(_recipe("Roast tomatoes"))

    result = await photograph(photos, [dish], deadline=PipelineDeadline(7))

    assert photos.titles == []
    photo = result[ImageService.recipe_key(dish)]
    assert photo.status == "unavailable" and photo.reason == "late"


async def test_titles_the_feed_already_showed_get_no_photo():
    photos = RecordingPhotos(delay=0)
    provider = MealFakeProvider(
        [
            *batch_responses(_recipe("Roast tomatoes"), _recipe("tomato  SOUP")),
        ]
    )
    graph = build_recipe_generation_graph(provider, photos=photos)
    state = {**_refill_state(PipelineDeadline(45)), "exclude_titles": ["Tomato soup"]}

    await graph.ainvoke(state)

    assert photos.titles == ["Roast tomatoes"]


async def test_graphs_without_a_photo_source_keep_their_full_deadline():
    clock = Clock()
    provider = ClockedProvider(
        [*batch_responses(_recipe("Roast tomatoes"))], clock, []
    )
    graph = build_recipe_generation_graph(provider)

    result = await graph.ainvoke(_refill_state(PipelineDeadline(45, clock=clock)))

    assert provider.remaining_at_call[0] == pytest.approx(
        45 - MEAL_REVIEW_RESERVE_SECONDS
    )
    assert "recipe_photos" not in result


class _Retriever:
    async def search(self, query: str, **_: Any) -> list[RetrievedRecipe]:
        return []


class SlowCallsProvider:
    """Answers from a queue, holding each generation call for its delay."""

    def __init__(self, responses: list[Any], delays: list[float]) -> None:
        self._inner = MealFakeProvider(responses)
        self._delays = list(delays)
        self.generation_calls = 0

    async def generate(self, prompt: str, **kwargs: Any) -> Any:
        if kwargs["response_model"] is MealCheck:
            return await self._inner.generate(prompt, **kwargs)
        delay = self._delays[self.generation_calls]
        self.generation_calls += 1
        response = await self._inner.generate(prompt, **kwargs)
        await asyncio.sleep(delay)
        return response


async def test_a_batch_returns_once_its_first_three_recipes_have_photos():
    photos = RecordingPhotos(delay=0.05)
    provider = SlowCallsProvider(
        batch_responses(*(_recipe(f"Dish {n}") for n in range(1, 6))),
        delays=[0.04, 0.01, 0.03, 0.02, 5.0],
    )
    graph = build_recipe_generation_graph(
        provider, photos=photos, quality_retry_limit=0
    )

    started = time.monotonic()
    result = await graph.ainvoke(_refill_state(PipelineDeadline(45)))

    assert time.monotonic() - started < 1.0
    assert [r.title for r in result["valid_recipes"]] == [
        "Dish 2",
        "Dish 4",
        "Dish 3",
        "Dish 1",
    ]
    assert photos.titles == ["Dish 2", "Dish 4", "Dish 3"]
    assert [_photo_of(result, title).status for title in photos.titles] == [
        "ready"
    ] * 3
    assert len(result["recipe_photos"]) == 3


async def test_a_near_duplicate_dish_never_takes_one_of_the_first_photos():
    photos = RecordingPhotos(delay=0)
    provider = SlowCallsProvider(
        batch_responses(
            _recipe("Roast tomatoes"),
            _recipe("The roast tomatoes"),
            _recipe("Tomato soup"),
            _recipe("Tomato salad"),
        ),
        delays=[0.01, 0.02, 0.03, 0.04, 0.05],
    )
    graph = build_recipe_generation_graph(
        provider, photos=photos, quality_retry_limit=0
    )

    result = await graph.ainvoke(_refill_state(PipelineDeadline(45)))

    assert photos.titles == ["Roast tomatoes", "Tomato soup", "Tomato salad"]
    assert [r.title for r in result["valid_recipes"]] == photos.titles


async def test_feed_budgets_leave_the_recipe_steps_time_for_a_slow_generation():
    # Measured in a live feed load: reading foods, analysis and generation.
    slow_generation = 18
    for budget in (
        settings.recipe_feed_initial_budget_seconds,
        settings.recipe_feed_page_budget_seconds,
    ):
        steps = budget - PHOTO_RESERVE_SECONDS
        assert steps - slow_generation >= GEMINI_MIN_DEADLINE_SECONDS
