"""Typed state values shared by recipe graph nodes."""

from __future__ import annotations

from collections.abc import Mapping
from datetime import date
from typing import Any, TypedDict

from app.ai.agents.models import Recipe
from app.ai.llm.retry import PipelineDeadline
from app.ai.rag.vector_store import RetrievedRecipe


class InventoryItem(TypedDict, total=False):
    """The inventory fields consumed by recipe analysis.

    ``depleted_at`` is optional until the cook-flow migration adds the column
    to the live inventory table. Keeping it optional lets the graph support
    both the current and MVP inventory response shapes.
    """

    id: str
    name: str
    quantity: float
    unit: str
    expiration_date: str | date | None
    depleted_at: Any


class UsableItem(TypedDict):
    """An inventory item that is safe to include in recipe generation."""

    id: str
    name: str
    quantity: float
    unit: str
    expiration_date: date | None
    days_until_expiration: int | None
    is_expiring: bool


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


class RecipeState(TypedDict, total=False):
    """The shared state carried through the four-node recipe graph."""

    inventory: list[InventoryItem | Mapping[str, Any]]
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
