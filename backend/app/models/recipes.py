"""DTOs for the authenticated recipe suggestion endpoint."""

from __future__ import annotations

import math
from typing import Annotated, Any, Literal
from uuid import UUID

from pydantic import (
    AfterValidator,
    BaseModel,
    ConfigDict,
    Field,
    StrictInt,
    field_validator,
    model_validator,
)

from app.ai.agents.limits import DEFAULT_BATCH_CEILING, MAX_BATCH_CEILING
from app.ai.agents.models import Recipe


class RecipeSuggestionRequest(BaseModel):
    """Request body for one session-scoped recipe suggestion batch.

    The backend reads ``household_id``'s foods itself, as the caller.
    """

    model_config = ConfigDict(extra="forbid")

    household_id: UUID
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


class RecipeFeedSessionRequest(BaseModel):
    """Input used to create one server-owned recipe feed session.

    The backend reads ``household_id``'s foods itself, as the caller.
    """

    model_config = ConfigDict(extra="forbid")

    household_id: UUID
    preferences: dict[str, Any] = Field(default_factory=dict)


class RecipeFeedPageRequest(BaseModel):
    """Cursor and page-size contract for one feed continuation request."""

    model_config = ConfigDict(extra="forbid")

    cursor: str = Field(default="0", min_length=1, max_length=32)
    limit: StrictInt = Field(default=5, ge=1, le=5)


class RecipeFeedData(BaseModel):
    """One stable page from a server-owned recipe feed session."""

    session_id: UUID
    recipes: list[RecipeSuggestion]
    next_cursor: str | None = None
    has_more: bool
    ready_count: int = Field(default=0, ge=0)
    empty_reason: str | None = None


class RecipeFeedResponse(BaseModel):
    """Envelope used by the cursor-backed recipe feed endpoints."""

    data: RecipeFeedData


def _require_finite(value: float) -> float:
    if not math.isfinite(value):
        raise ValueError("Amount must be finite")
    return value


_FiniteFloat = Annotated[float, AfterValidator(_require_finite)]


class CookDeduction(BaseModel):
    """One food a confirmed cook used, and how much.

    Attributes:
        inventory_item_id: The food the recipe line names. Recipes saved
            before foods existed hold a lot id here instead, and the
            deduction draws from that lot's food. A merged food draws from
            the food it was merged into.
        confirmed_amount: How much was used, in the food's stock base (grams,
            millilitres or a count). Must be finite and positive.
    """

    inventory_item_id: UUID
    confirmed_amount: _FiniteFloat = Field(gt=0)


class CookIngredientLine(BaseModel):
    """One recipe ingredient as cooked, recorded on the cook event for Cook Again.

    Only ingredients matched to a food get a line. Cook Again reads the others
    from the recipe snapshot.

    Attributes:
        ingredient: The ingredient's name as the recipe lists it.
        inventory_item_id: The food the line uses, or a lot id from a recipe
            saved before foods existed.
        recipe_amount: The recipe's amount in ``recipe_unit``. 0 for amounts
            such as "to taste".
        recipe_unit: The recipe's unit as written, such as "tbsp" or "clove".
        mode: ``draw`` when the amount converted, ``small`` for a
            seasoning-sized amount that is never drawn, or ``ask`` when the
            cook was asked how much was used.
        stock_amount: The line's amount in the food's stock base. Required for
            ``draw``, null for ``small``, and null for an ``ask`` the cook
            skipped.

    Raises:
        pydantic.ValidationError: On construction, when ``stock_amount``
            breaks the rule for its ``mode`` or ``ingredient`` is blank.
    """

    model_config = ConfigDict(extra="forbid")
    ingredient: str = Field(min_length=1, max_length=200)
    inventory_item_id: UUID
    recipe_amount: _FiniteFloat = Field(ge=0)
    recipe_unit: str = Field(min_length=1, max_length=64)
    mode: Literal["draw", "small", "ask"]
    stock_amount: _FiniteFloat | None = Field(default=None, ge=0)

    @model_validator(mode="after")
    def check_line(self) -> CookIngredientLine:
        if not self.ingredient.strip():
            raise ValueError("Ingredient must not be blank")
        if self.mode == "draw" and self.stock_amount is None:
            raise ValueError("A draw line needs a stock amount")
        if self.mode == "small" and self.stock_amount is not None:
            raise ValueError("A small line has no stock amount")
        return self


class CookConfirmationRequest(BaseModel):
    """Request body for confirming a finished cook.

    Attributes:
        household_id: The caller's household.
        operation_id: The id the app made when the cook started. Repeating a
            request with the same id and payload deducts once.
        recipe_id: The recipe that was cooked.
        recipe_snapshot: The recipe as cooked. Its ``recipe_id`` must match.
        deductions: One entry per food used. Two entries that reach the same
            food, such as a food and one of its lots, are rejected.
        lines: One entry per matched recipe ingredient, in recipe order. Each
            deduction needs at least one ``draw`` or answered ``ask`` line on
            its food, and its draws are split across those lines.
    """

    model_config = ConfigDict(extra="forbid")
    household_id: UUID
    operation_id: UUID
    recipe_id: UUID
    recipe_snapshot: dict[str, Any]
    deductions: list[CookDeduction]
    lines: list[CookIngredientLine] = Field(min_length=1)

    @field_validator("recipe_snapshot")
    @classmethod
    def snapshot_matches(cls, value: dict[str, Any], info):
        recipe_id = info.data.get("recipe_id")
        if value.get("recipe_id") != str(recipe_id):
            raise ValueError("Recipe snapshot identity does not match recipe_id")
        return value
