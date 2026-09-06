"""Semantic meal review for deterministically grounded recipes."""

from __future__ import annotations

import asyncio
import json
from typing import Any, Literal, Mapping

from pydantic import BaseModel, ConfigDict, Field, StrictInt

from app.ai.agents.models import Recipe
from app.ai.agents.nodes import RecipeProviderPort
from app.ai.llm.errors import ProviderError
from app.ai.llm.retry import PipelineDeadline
from app.ai.prompts.loader import PromptTemplate, load_prompt


class MealDecision(BaseModel):
    model_config = ConfigDict(extra="forbid")
    candidate_index: StrictInt
    verdict: Literal[
        "eligible", "insufficient", "incoherent", "unsupported_ingredient", "unknown"
    ]
    reason: str = Field(min_length=1)


class MealAssessment(BaseModel):
    model_config = ConfigDict(extra="forbid")
    decisions: list[MealDecision]


async def assess_meals(
    recipes: list[Recipe],
    state: Mapping[str, Any],
    provider: RecipeProviderPort,
    *,
    prompt: PromptTemplate | None = None,
    deadline: PipelineDeadline | None = None,
) -> tuple[list[Recipe], str | None, dict[str, Any]]:
    template = prompt or load_prompt("assess_meals")
    inventory = state.get("usable_items", [])
    payload = {
        "candidates": [recipe.model_dump(mode="json") for recipe in recipes],
        "inventory": list(inventory),
        "preferences": state.get("preferences", {}),
    }
    try:
        response = await provider.generate(
            json.dumps(payload, sort_keys=True, default=str),
            response_model=MealAssessment,
            system_instruction=template.system,
            deadline=deadline,
        )
        assessment = MealAssessment.model_validate(response)
        expected = set(range(len(recipes)))
        indices = [decision.candidate_index for decision in assessment.decisions]
        if set(indices) != expected or len(indices) != len(set(indices)):
            raise ValueError("Meal assessment must contain one decision per candidate")
    except ProviderError:
        raise
    except asyncio.CancelledError:
        raise
    except BaseException as exc:
        if isinstance(exc, (KeyboardInterrupt, SystemExit)):
            raise
        raise ProviderError("Meal assessment unavailable", cause=exc) from exc

    eligible: list[Recipe] = []
    failures: list[str] = []
    for decision in assessment.decisions:
        recipe = recipes[decision.candidate_index]
        if decision.verdict == "eligible":
            eligible.append(recipe)
        else:
            failures.append(
                f"Recipe '{recipe.title}': {decision.verdict}: {decision.reason}"
            )
    return eligible, "\n".join(failures) if failures else None, {
        "assessment_prompt_name": template.name,
        "assessment_prompt_version": template.version,
    }
