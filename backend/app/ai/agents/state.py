"""Typed state values shared by recipe graph nodes."""

from __future__ import annotations

from collections.abc import Mapping
from datetime import date
from typing import Any, NotRequired

# Pydantic validates feed refills' stored usable items against these, and on
# Python 3.11 it accepts only typing_extensions TypedDicts.
from typing_extensions import TypedDict

from app.ai.agents.models import Recipe
from app.ai.llm.retry import PipelineDeadline
from app.ai.rag.vector_store import RetrievedRecipe
from app.models.images import ImageResult


class UsableItem(TypedDict):
    """One food recipe generation may use, with its unexpired stock.

    ``quantity`` is the food's available stock in ``unit``, its stock unit
    ("g", "ml", or a count word such as "head"). ``units`` lists the recipe
    units the converter can turn into a number for this food, and an
    ingredient must use one of them. ``expiration_date`` is the soonest
    unexpired batch's date. ``food`` is the ``FoodLine`` the item came from,
    in JSON form, so a feed refill can rebuild its unit facts.
    """

    id: str
    name: str
    quantity: float
    unit: str
    units: list[str]
    lot_count: int
    expiration_date: date | None
    days_until_expiration: int | None
    is_expiring: bool
    food: dict[str, Any]


class InventoryAnalysis(TypedDict):
    """State update returned by ``analyze_inventory``."""

    usable_items: list[UsableItem]
    query_terms: list[str]


class RetrievalResult(TypedDict):
    """State update returned by ``retrieve_recipes``."""

    retrieved_recipes: list[RetrievedRecipe]


class GenerationResult(TypedDict):
    """State update returned by ``generate_recipes``."""

    generated_recipes: list[Recipe]
    retry_count: int


class QualityResult(TypedDict):
    """State update returned by ``check_quality``."""

    valid_recipes: list[Recipe]
    quality_feedback: str | None
    metadata: NotRequired[dict[str, Any]]


class PhotoResult(TypedDict):
    """State update returned by the photo step."""

    recipe_photos: dict[str, ImageResult]


class SteeringExample(TypedDict):
    """A recipe the cook picked "More like this" or "Less like this" on.

    ``foods`` lists the recipe's ingredient names, in recipe order.
    """

    title: str
    foods: list[str]


class RecipeSteering(TypedDict):
    """Recipes generation should move toward (``more_like``) or away from."""

    more_like: list[SteeringExample]
    less_like: list[SteeringExample]


class RecipeState(TypedDict, total=False):
    """The shared state carried through the recipe graph.

    ``inventory`` holds one ``FoodLine`` mapping per household food.
    ``recipe_photos`` maps each valid recipe's photo cache key
    (``ImageService.recipe_key``) to its photo. Only graphs built with a
    photo source set it. ``steering`` is absent when the cook hasn't picked
    "More like this" or "Less like this" on any recipe.
    """

    inventory: list[Mapping[str, Any]]
    preferences: Mapping[str, Any]
    exclude_titles: list[str]
    batch_ceiling: int
    usable_items: list[UsableItem]
    query_terms: list[str]
    retrieved_recipes: list[RetrievedRecipe]
    generated_recipes: list[Recipe]
    valid_recipes: list[Recipe]
    quality_feedback: str | None
    retry_count: int
    errors: list[str]
    metadata: dict[str, Any]
    deadline: PipelineDeadline
    recipe_photos: dict[str, ImageResult]
    steering: RecipeSteering
