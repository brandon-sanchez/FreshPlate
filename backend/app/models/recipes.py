"""DTOs for the authenticated recipe suggestion endpoint."""

from __future__ import annotations

import math
from datetime import date
from typing import Any
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, StrictInt, field_validator

from app.ai.agents.limits import DEFAULT_BATCH_CEILING, MAX_BATCH_CEILING
from app.ai.agents.models import Recipe


class RecipeInventoryContext(BaseModel):
    """The client-owned inventory snapshot used for one generation request."""

    model_config = ConfigDict(extra="forbid")

    id: str = Field(min_length=1)
    name: str = Field(min_length=1)
    quantity: float = Field(default=1, ge=0)
    unit: str = Field(default="item", min_length=1)
    expiration_date: date | None = None
    depleted_at: str | None = None

    @field_validator("id", "name", "unit")
    @classmethod
    def normalize_required_text(cls, value: str) -> str:
        """Reject blank labels while keeping the graph input canonical."""
        normalized = value.strip()
        if not normalized:
            raise ValueError("Inventory text must not be blank")
        return normalized

    @field_validator("quantity")
    @classmethod
    def require_finite_quantity(cls, value: float) -> float:
        """Prevent non-finite quantities from crossing the HTTP boundary."""
        if not math.isfinite(value):
            raise ValueError("Inventory quantity must be finite")
        return value


class RecipeSuggestionRequest(BaseModel):
    """Request body for one session-scoped recipe suggestion batch."""

    model_config = ConfigDict(extra="forbid")

    inventory: list[RecipeInventoryContext] = Field(default_factory=list)
    preferences: dict[str, Any] = Field(default_factory=dict)
    exclude_titles: list[str] = Field(default_factory=list)
    batch_ceiling: StrictInt = Field(
        default=DEFAULT_BATCH_CEILING,
        ge=0,
        le=MAX_BATCH_CEILING,
    )

    @field_validator("exclude_titles")
    @classmethod
    def normalize_excluded_titles(cls, values: list[str]) -> list[str]:
        """Ignore blank entries while preserving the caller's title list."""
        return [title.strip() for title in values if title.strip()]


class RecipeSuggestion(Recipe):
    """A validated recipe enriched with feed and cook-flow metadata."""

    recipe_id: UUID
    match_percent: int = Field(ge=0, le=100)
    saves_expiring: list[str] = Field(default_factory=list)


class RecipeSuggestionsData(BaseModel):
    """Successful recipe suggestion payload."""

    recipes: list[RecipeSuggestion]


class RecipeSuggestionsResponse(BaseModel):
    """Envelope used by the public API response convention."""

    data: RecipeSuggestionsData
