"""Semantic meal review for deterministically grounded recipes."""

from __future__ import annotations

import json
from collections.abc import Mapping
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, StrictInt

from app.ai.agents.dish import RequestedDish, requested_dish
from app.ai.agents.kitchen_basics import KitchenBasics
from app.ai.agents.models import Recipe
from app.ai.agents.nodes import check_quality
from app.ai.agents.state import QualityResult
from app.ai.llm.errors import ProviderError
from app.ai.llm.protocol import LLMProvider
from app.ai.llm.retry import PipelineDeadline
from app.ai.prompts.loader import PromptTemplate, load_prompt

MealVerdict = Literal[
    "eligible", "wrong_dish", "insufficient", "incoherent", "unsupported_ingredient"
]


class MealCheck(BaseModel):
    """One recipe's checklist answers.

    Structured output is written in key order, so the reasoning fields come
    before the yes/no answers they justify. Code, not the model, turns the
    answers into a verdict.
    """

    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    candidate_index: StrictInt
    main_component: str = Field(
        description="The food that makes this dish the requested dish, with its "
        "amount per serving."
    )
    dish_reasoning: str = Field(
        description="What kind of dish is this: a meal, a snack, a dessert, a "
        "side dish, a garnish plate or something else? Would most people eat it "
        "on its own as the requested_dish?"
    )
    portion_reasoning: str = Field(
        description="Is the amount of food per serving what a person would eat as "
        "the requested_dish? Compare the main component and total food to the "
        "stated servings."
    )
    unlisted_foods: list[str] = Field(
        description="Foods named in the title, steps or ingredients that are not in "
        "the kitchen items. An ingredient is listed only when it is the same food "
        "as the kitchen item whose recipe_names include it. Kitchen basics never "
        "count."
    )
    is_requested_dish: bool = Field(
        description="True if most people would eat this on its own as the "
        "requested_dish. False for a side dish, a garnish plate, vegetables that "
        "are not built into a full dish, a plain or lightly flavored grain or "
        "starch with a few vegetables, or one ingredient plus seasoning. When the "
        "requested_dish is a meal, also False for a snack, a snack plate or a "
        "dessert."
    )
    realistic_portions: bool
    coherent_method: bool = Field(
        description="True if the steps form a sensible way to cook this dish."
    )


class MealChecklist(BaseModel):
    model_config = ConfigDict(extra="forbid")
    checks: list[MealCheck]


def meal_verdict(
    check: MealCheck, dish: RequestedDish, basics: KitchenBasics
) -> tuple[MealVerdict, str]:
    """Return the first failed checklist answer as a verdict and reason.

    The reason goes back to the generator as retry feedback, so a
    ``wrong_dish`` reason names the dish the cook asked for. A food the
    judge calls unlisted is ignored when it is one of ``basics``, the
    household's kitchen basics.
    """
    unlisted = [food for food in check.unlisted_foods if food not in basics]
    if unlisted:
        return "unsupported_ingredient", f"names foods not in the kitchen: {unlisted}"
    if not check.is_requested_dish:
        return "wrong_dish", f"not a {dish} on its own: {check.dish_reasoning}"
    if not check.realistic_portions:
        return "insufficient", check.portion_reasoning
    if not check.coherent_method:
        return "incoherent", "steps do not form a sensible method"
    return "eligible", check.main_component


async def assess_meals(
    recipes: list[Recipe],
    state: Mapping[str, Any],
    provider: LLMProvider,
    *,
    prompt: PromptTemplate | None = None,
    deadline: PipelineDeadline,
) -> tuple[list[Recipe], str | None, dict[str, Any]]:
    """Keep the recipes a Gemini judge finds to be the dish the cook asked for.

    Makes one provider call for the whole batch. The judge is told which
    dish the session asks for, from ``requested_dish``, and sees only the
    kitchen items each recipe uses, plus the kitchen basics.

    Args:
        recipes: Recipes that already passed the inventory checks.
        state: The recipe state; ``usable_items``, ``kitchen_basics`` and
            ``preferences`` are read.
        provider: The model client the judge runs on.
        prompt: The judge prompt, or None to load ``assess_meals``.
        deadline: The pipeline deadline the call must finish inside.

    Returns:
        The eligible recipes in their original order, the rejection reasons
        joined one per line (None when every recipe passes), and the judge
        prompt's name and version for trace metadata.

    Raises:
        ProviderError: When the call fails, the deadline runs out, or the
            checklist does not answer every recipe exactly once.
    """
    template = prompt or load_prompt("assess_meals")
    inventory_by_id = {item["id"]: item for item in state.get("usable_items", [])}
    preferences = state.get("preferences", {})
    dish = requested_dish(preferences)
    basics = KitchenBasics.parse(state.get("kitchen_basics"))
    payload = {
        "candidates": [
            {
                "candidate_index": index,
                "recipe": recipe.model_dump(mode="json"),
                "kitchen_items": _kitchen_items(recipe, inventory_by_id),
            }
            for index, recipe in enumerate(recipes)
        ],
        "kitchen_basics": list(basics.names),
        "preferences": preferences,
        "requested_dish": dish,
    }
    if deadline.expired:
        raise ProviderError("Meal assessment deadline exhausted")
    try:
        response = await provider.generate(
            json.dumps(payload, sort_keys=True, default=str),
            response_model=MealChecklist,
            system_instruction=template.system,
            deadline=deadline,
            thinking=template.thinking,
        )
        if deadline.expired:
            raise ProviderError("Meal assessment deadline exhausted")
        checklist = MealChecklist.model_validate(response)
        expected = set(range(len(recipes)))
        indices = [check.candidate_index for check in checklist.checks]
        if set(indices) != expected or len(indices) != len(set(indices)):
            raise ValueError("Meal checklist must contain one entry per candidate")
    except ProviderError:
        raise
    except Exception as exc:
        raise ProviderError("Meal assessment unavailable", cause=exc) from exc

    eligible: list[Recipe] = []
    failures: list[str] = []
    checks_by_index = {check.candidate_index: check for check in checklist.checks}
    for index, recipe in enumerate(recipes):
        verdict, reason = meal_verdict(checks_by_index[index], dish, basics)
        if verdict == "eligible":
            eligible.append(recipe)
        else:
            failures.append(f"Recipe '{recipe.title}': {verdict}: {reason}")
    return eligible, "\n".join(failures) if failures else None, {
        "assessment_prompt_name": template.name,
        "assessment_prompt_version": template.version,
    }


def _kitchen_items(
    recipe: Recipe, inventory_by_id: Mapping[str, Mapping[str, Any]]
) -> list[dict[str, Any]]:
    """Return the inventory items this recipe uses, in their stock units.

    The judge only needs the items a recipe draws on, so its prompt stays the
    same size whether the kitchen holds ten items or five hundred. Each item
    lists the recipe's names for the ingredients mapped to it, because the
    generation schema makes every ingredient pick a food, and the judge is
    what catches "chicken thighs" mapped to the olive oil.
    """
    items: dict[str, dict[str, Any]] = {}
    for ingredient in recipe.ingredients:
        if ingredient.inventory_item_id in inventory_by_id:
            item = inventory_by_id[ingredient.inventory_item_id]
            entry = items.setdefault(
                item["id"],
                {
                    "name": item["name"],
                    "quantity": item["quantity"],
                    "unit": item["unit"],
                    "recipe_names": [],
                },
            )
            entry["recipe_names"].append(ingredient.name)
    return list(items.values())


async def review_recipes(
    state: Mapping[str, Any],
    provider: LLMProvider,
    *,
    deadline: PipelineDeadline,
) -> QualityResult:
    """Reject inventory failures before assessing the remaining meals."""
    result = check_quality(state)
    if not result["valid_recipes"]:
        return result
    eligible, feedback, metadata = await assess_meals(
        result["valid_recipes"], state, provider, deadline=deadline
    )
    return {
        "valid_recipes": eligible,
        "quality_feedback": "\n".join(
            value for value in (result["quality_feedback"], feedback) if value
        ) or None,
        "metadata": {**state.get("metadata", {}), **metadata},
    }
