"""Semantic meal review for deterministically grounded recipes."""

from __future__ import annotations

import json
from collections.abc import Mapping
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, StrictInt

from app.ai.agents.models import Recipe
from app.ai.agents.nodes import check_quality
from app.ai.agents.state import QualityResult
from app.ai.llm.errors import ProviderError
from app.ai.llm.protocol import LLMProvider
from app.ai.llm.retry import PipelineDeadline
from app.ai.prompts.loader import PromptTemplate, load_prompt


class MealDecision(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
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
    provider: LLMProvider,
    *,
    prompt: PromptTemplate | None = None,
    deadline: PipelineDeadline,
) -> tuple[list[Recipe], str | None, dict[str, Any]]:
    template = prompt or load_prompt("assess_meals")
    inventory = state.get("usable_items", [])
    payload = {
        "candidates": [
            {"candidate_index": index, "recipe": recipe.model_dump(mode="json")}
            for index, recipe in enumerate(recipes)
        ],
        "inventory": list(inventory),
        "preferences": state.get("preferences", {}),
    }
    if deadline.expired:
        raise ProviderError("Meal assessment deadline exhausted")
    try:
        response = await provider.generate(
            json.dumps(payload, sort_keys=True, default=str),
            response_model=MealAssessment,
            system_instruction=template.system,
            deadline=deadline,
        )
        if deadline.expired:
            raise ProviderError("Meal assessment deadline exhausted")
        assessment = MealAssessment.model_validate(response)
        expected = set(range(len(recipes)))
        indices = [decision.candidate_index for decision in assessment.decisions]
        if set(indices) != expected or len(indices) != len(set(indices)):
            raise ValueError("Meal assessment must contain one decision per candidate")
    except ProviderError:
        raise
    except Exception as exc:
        raise ProviderError("Meal assessment unavailable", cause=exc) from exc

    eligible: list[Recipe] = []
    failures: list[str] = []
    decisions_by_index = {d.candidate_index: d for d in assessment.decisions}
    for index, recipe in enumerate(recipes):
        decision = decisions_by_index[index]
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
