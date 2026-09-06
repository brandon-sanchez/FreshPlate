"""Structured recipe models exchanged with the generation provider."""

from __future__ import annotations

import math

from pydantic import BaseModel, ConfigDict, Field, field_validator


class RecipeIngredient(BaseModel):
    """One recipe ingredient and its optional tracked-inventory mapping."""

    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1)
    inventory_item_id: str | None = None
    use_amount: float | None = None
    unit: str = Field(min_length=1)

    @field_validator("name", "unit")
    @classmethod
    def reject_blank_text(cls, value: str) -> str:
        """Keep structured ingredient labels useful to the UI and checks."""
        if not value.strip():
            raise ValueError("Ingredient text must not be blank")
        return value.strip()

    @field_validator("use_amount")
    @classmethod
    def require_finite_amount(cls, value: float | None) -> float | None:
        """Prevent NaN and infinity from crossing the provider seam."""
        if value is not None and not math.isfinite(value):
            raise ValueError("Ingredient amount must be finite")
        return value


class Recipe(BaseModel):
    """A generated recipe before it receives a persistent recipe identity."""

    model_config = ConfigDict(extra="forbid")

    title: str = Field(min_length=1)
    cook_time_minutes: int = Field(gt=0)
    servings: int = Field(gt=0)
    ingredients: list[RecipeIngredient] = Field(min_length=1)
    steps: list[str] = Field(min_length=1)

    @field_validator("title")
    @classmethod
    def reject_blank_title(cls, value: str) -> str:
        """Require a visible recipe title."""
        if not value.strip():
            raise ValueError("Recipe title must not be blank")
        return value.strip()

    @field_validator("steps")
    @classmethod
    def reject_blank_steps(cls, value: list[str]) -> list[str]:
        """Require every cooking step to contain usable instructions."""
        if any(not step.strip() for step in value):
            raise ValueError("Recipe steps must not be blank")
        return [step.strip() for step in value]


class RecipeGenerationResponse(BaseModel):
    """The provider response requested by the recipe generation node."""

    model_config = ConfigDict(extra="forbid")

    recipes: list[Recipe] = Field(default_factory=list)
