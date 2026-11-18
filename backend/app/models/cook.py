"""DTOs for the done-cooking checklist plan."""

from __future__ import annotations

from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field

from app.ai.agents.models import RecipeIngredient
from app.inventory.cook_plan import CookLineMode
from app.inventory.units import StockBase

_MAX_INGREDIENTS = 100


class CookPlanRequest(BaseModel):
    """Request body for planning a finished cook's checklist.

    Attributes:
        household_id: The caller's household. Its foods are read as the
            caller, so a household the caller is not in plans as an empty
            kitchen.
        ingredients: The cooked recipe's ingredients, in recipe order, as the
            recipe lists them.
    """

    model_config = ConfigDict(extra="forbid")
    household_id: UUID
    ingredients: list[RecipeIngredient] = Field(
        min_length=1, max_length=_MAX_INGREDIENTS
    )


class CookPlanLine(BaseModel):
    """One recipe ingredient on a food, ready to send back as a cook line.

    Attributes:
        line: The ingredient's index in the request's ``ingredients``.
        ingredient: The ingredient's name, cut to the cook line's 200
            characters.
        recipe_amount: The recipe's amount, 0 when the recipe gave none.
        recipe_unit: The recipe's unit, cut to the cook line's 64
            characters.
        mode: ``draw`` when the amount converted, ``small`` for a
            seasoning-sized amount that is never drawn, or ``ask`` when the
            checklist must ask how much was used.
        stock_amount: For ``draw``, the line's amount in the food's stock
            base. None otherwise.
    """

    line: int
    ingredient: str
    recipe_amount: float
    recipe_unit: str
    mode: CookLineMode
    stock_amount: float | None


class CookPlanFood(BaseModel):
    """One food the recipe uses, with its stock and the amount to pre-fill.

    Attributes:
        food_id: The food.
        name: The food's name.
        stock_base: The unit ``available``, ``draw`` and line amounts are in.
        each_label: The counted unit, such as "egg". Set exactly when
            ``stock_base`` is ``"each"``.
        whole_units_only: True for counted foods that can't be split.
        available: The food's unexpired stock when the plan was made.
        draw: The summed amount of the food's ``draw`` lines, rounded up to
            whole units for a whole-units food. 0 when nothing converted.
        estimated: True when a profile estimate went into ``draw``, so the
            app shows it as "about".
        rounding_note: Set when ``draw`` was rounded up, such as "Uses 2
            eggs, recipe needs about 1.5".
        lines: The ingredients on this food, in recipe order.
    """

    food_id: str
    name: str
    stock_base: StockBase
    each_label: str | None
    whole_units_only: bool
    available: float
    draw: float
    estimated: bool
    rounding_note: str | None
    lines: list[CookPlanLine]


class UntrackedIngredient(BaseModel):
    """An ingredient the cook takes nothing from stock for.

    Attributes:
        line: The ingredient's index in the request's ``ingredients``.
        name: The ingredient's name.
        reason: ``basic`` for a kitchen basic the recipe maps to no food, or
            ``not_in_kitchen`` for a food with no unexpired stock left.
    """

    line: int
    name: str
    reason: Literal["basic", "not_in_kitchen"]


class CookPlanData(BaseModel):
    """The done-cooking checklist for one recipe.

    Attributes:
        foods: One entry per tracked food, ordered by its first ingredient.
        untracked: The other ingredients, in recipe order.
    """

    foods: list[CookPlanFood]
    untracked: list[UntrackedIngredient]


class CookPlanResponse(BaseModel):
    """Envelope used by the public API response convention."""

    data: CookPlanData
