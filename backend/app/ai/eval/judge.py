"""Structured LLM judge for recipe preference and quantity safety."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from app.ai.agents.models import Recipe
from app.ai.llm.protocol import LLMProvider
from app.ai.llm.retry import PipelineDeadline


class JudgeResult(BaseModel):
    """The single rubric returned for one generated recipe."""

    model_config = ConfigDict(extra="forbid")

    preference_alignment: int = Field(ge=0, le=100)
    quantity_violations: list[str] = Field(default_factory=list)
    rationale: str = Field(min_length=1)

    @property
    def passed(self) -> bool:
        """Return whether the recipe has no gross quantity violations."""
        return not self.quantity_violations


JUDGE_SYSTEM = """You judge FreshPlate recipes with one rubric.
Score preference alignment from 0 to 100 against the requested dish name and inventory.
List every gross or implausible quantity violation. A quantity is a violation when it
exceeds the available inventory, is zero or negative, or is implausible for the unit.
Return only the requested JSON object. Do not reward ingredients that are absent from
the inventory merely because they are common pantry staples."""


def build_judge_prompt(
    recipe: Recipe,
    *,
    request: str,
    inventory: Sequence[Mapping[str, Any]],
) -> str:
    """Build the stable, inspectable judge input."""
    return "\n".join(
        (
            f"Requested dish: {request}",
            f"Inventory: {list(inventory)}",
            f"Recipe: {recipe.model_dump(mode='json')}",
            "Evaluate preference alignment and quantity safety.",
        )
    )


async def judge_recipe(
    provider: LLMProvider,
    recipe: Recipe,
    *,
    request: str,
    inventory: Sequence[Mapping[str, Any]],
    deadline: PipelineDeadline | None = None,
) -> JudgeResult:
    """Run the one-rubric judge through the normal structured provider seam."""
    return await provider.generate(
        build_judge_prompt(recipe, request=request, inventory=inventory),
        response_model=JudgeResult,
        system_instruction=JUDGE_SYSTEM,
        deadline=deadline,
    )
