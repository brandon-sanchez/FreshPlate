"""Semantic meal review for deterministically grounded recipes."""

from __future__ import annotations

import json
from collections.abc import Mapping
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, StrictInt

from app.ai.agents.models import Recipe
from app.ai.agents.nodes import check_quality, is_water
from app.ai.agents.state import QualityResult
from app.ai.llm.errors import ProviderError
from app.ai.llm.protocol import LLMProvider
from app.ai.llm.retry import PipelineDeadline
from app.ai.prompts.loader import PromptTemplate, load_prompt

MealVerdict = Literal[
    "eligible", "insufficient", "incoherent", "unsupported_ingredient"
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
        description="The food that makes this dish a meal, with its amount per serving."
    )
    portion_reasoning: str = Field(
        description="Is the amount of food per serving what a person would eat as a "
        "meal? Compare the main component and total food to the stated servings."
    )
    unlisted_foods: list[str] = Field(
        description="Foods named in the title or steps that are not in the kitchen "
        "items. Water never counts."
    )
    is_full_meal: bool = Field(
        description="True if this is a dish a person would serve as their meal. "
        "False for a side dish, a plain or lightly flavored grain or starch with a "
        "few vegetables, or one ingredient plus seasoning."
    )
    realistic_portions: bool
    coherent_method: bool = Field(
        description="True if the steps form a sensible way to cook this dish."
    )


class MealChecklist(BaseModel):
    model_config = ConfigDict(extra="forbid")
    checks: list[MealCheck]


def meal_verdict(check: MealCheck) -> tuple[MealVerdict, str]:
    """Return the first failed checklist answer as a verdict and reason."""
    unlisted = [food for food in check.unlisted_foods if not is_water(food)]
    if unlisted:
        return "unsupported_ingredient", f"names foods not in the kitchen: {unlisted}"
    if not check.is_full_meal:
        return "insufficient", f"not a full meal; main: {check.main_component}"
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
    template = prompt or load_prompt("assess_meals")
    inventory_by_id = {item["id"]: item for item in state.get("usable_items", [])}
    payload = {
        "candidates": [
            {
                "candidate_index": index,
                "recipe": recipe.model_dump(mode="json"),
                "kitchen_items": _kitchen_items(recipe, inventory_by_id),
            }
            for index, recipe in enumerate(recipes)
        ],
        "preferences": state.get("preferences", {}),
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
        verdict, reason = meal_verdict(checks_by_index[index])
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
    """Return the inventory items this recipe uses, in the user's own units.

    The judge only needs the items a recipe draws on, so its prompt stays the
    same size whether the kitchen holds ten items or five hundred.
    """
    items: dict[str, dict[str, Any]] = {}
    for ingredient in recipe.ingredients:
        item = inventory_by_id.get(ingredient.inventory_item_id or "")
        if item is not None:
            items[item["id"]] = {
                "name": item["name"],
                "quantity": item["quantity"],
                "unit": item["unit"],
            }
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
