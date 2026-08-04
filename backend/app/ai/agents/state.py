"""Typed state values shared by recipe graph nodes."""

from __future__ import annotations

from collections.abc import Mapping
from datetime import date
from typing import Any, TypedDict

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


class RecipeState(TypedDict, total=False):
    """The fields written by the first two recipe graph nodes."""

    inventory: list[InventoryItem | Mapping[str, Any]]
    usable_items: list[UsableItem]
    query_terms: list[str]
    retrieved_recipes: list[RetrievedRecipe]
