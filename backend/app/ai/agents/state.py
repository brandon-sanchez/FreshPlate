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


class RecipeState(TypedDict, total=False):
    """The shared state carried through the four-node recipe graph.

    ``inventory`` holds one ``FoodLine`` mapping per household food.
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
