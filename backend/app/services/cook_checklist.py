"""Build the done-cooking checklist from a recipe and the household's foods."""

from __future__ import annotations

from collections.abc import Sequence
from decimal import Decimal
from uuid import UUID

from app.ai.agents.models import RecipeIngredient
from app.inventory.cook_plan import (
    CookLine,
    FoodPlan,
    FoodStock,
    LinePlan,
    plan_cook,
)
from app.inventory.food_facts import FoodLine
from app.models.cook import (
    CookPlanData,
    CookPlanFood,
    CookPlanLine,
    UntrackedIngredient,
)
from app.models.recipes import COOK_LINE_INGREDIENT_CHARS, COOK_LINE_UNIT_CHARS


def build_checklist(
    ingredients: Sequence[RecipeIngredient], foods: Sequence[FoodLine]
) -> CookPlanData:
    """Plan what a finished cook takes from each food the recipe uses.

    Args:
        ingredients: The recipe's ingredients, in recipe order.
        foods: The household's foods with unexpired stock.

    Returns:
        One planned food per food that has stock, and the ingredients that
        name no food or a food without stock as untracked.
    """
    by_id = {food.id: food for food in foods}
    tracked: list[tuple[int, RecipeIngredient]] = []
    untracked: list[UntrackedIngredient] = []
    for index, item in enumerate(ingredients):
        if item.inventory_item_id is None:
            untracked.append(
                UntrackedIngredient(line=index, name=item.name, reason="basic")
            )
        elif item.inventory_item_id not in by_id:
            untracked.append(
                UntrackedIngredient(line=index, name=item.name, reason="not_in_kitchen")
            )
        else:
            tracked.append((index, item))

    plan = plan_cook(
        [
            CookLine(UUID(item.inventory_item_id), _nonnegative_amount(item), item.unit)
            for _, item in tracked
        ],
        {
            UUID(food.id): FoodStock(food.facts, Decimal(str(food.available)))
            for food in foods
        },
    )
    return CookPlanData(
        foods=[_food(by_id[str(f.food_id)], f, tracked) for f in plan.foods],
        untracked=untracked,
    )


def _nonnegative_amount(item: RecipeIngredient) -> Decimal:
    return max(Decimal(str(item.use_amount or 0)), Decimal(0))


def _food(
    food: FoodLine, plan: FoodPlan, tracked: Sequence[tuple[int, RecipeIngredient]]
) -> CookPlanFood:
    return CookPlanFood(
        food_id=food.id,
        name=food.name,
        stock_base=food.stock_base,
        each_label=food.each_label,
        whole_units_only=food.whole_units_only,
        available=food.available,
        draw=float(plan.draw),
        estimated=plan.estimated,
        rounding_note=plan.rounding.note if plan.rounding else None,
        lines=[_line(*tracked[line.line], line) for line in plan.line_plans],
    )


def _line(index: int, item: RecipeIngredient, line: LinePlan) -> CookPlanLine:
    return CookPlanLine(
        line=index,
        ingredient=item.name[:COOK_LINE_INGREDIENT_CHARS],
        recipe_amount=float(_nonnegative_amount(item)),
        recipe_unit=item.unit[:COOK_LINE_UNIT_CHARS],
        mode=line.mode,
        stock_amount=None if line.stock_amount is None else float(line.stock_amount),
    )
