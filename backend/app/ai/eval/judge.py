"""LLM judge that grades one recipe for preference fit and quantity sanity."""

from __future__ import annotations

import json
from collections.abc import Mapping, Sequence
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from app.ai.agents.kitchen_basics import KitchenBasics
from app.ai.agents.models import Recipe
from app.ai.llm.errors import ProviderError
from app.ai.llm.protocol import LLMProvider
from app.ai.prompts.loader import load_prompt


class PreferenceCheck(BaseModel):
    """The judge's answer for one preference the cook stated.

    The reasoning field comes before ``met`` because structured output is
    written in key order, so the model explains before it answers.
    """

    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    preference: str = Field(
        description="The preference key being checked, such as diet."
    )
    reasoning: str = Field(
        description="How the recipe does or does not meet the cook's answer."
    )
    met: bool


class JudgeResult(BaseModel):
    """The judge's grade for one recipe under the single rubric.

    Attributes:
        preference_checks: One check per stated preference, in request order.
        quantity_reasoning: The judge's comparison of amounts with servings
            and stock, written before it lists violations.
        quantity_violations: One sentence per gross or implausible amount.
            Empty when every amount is reasonable.
    """

    model_config = ConfigDict(extra="forbid")

    preference_checks: list[PreferenceCheck]
    quantity_reasoning: str
    quantity_violations: list[str]

    @property
    def preference_alignment(self) -> int | None:
        """Return the percentage of stated preferences met, or None if none."""
        if not self.preference_checks:
            return None
        met = sum(check.met for check in self.preference_checks)
        return round(met * 100 / len(self.preference_checks))


async def judge_recipe(
    provider: LLMProvider,
    recipe: Recipe,
    *,
    preferences: Mapping[str, str],
    kitchen: Sequence[Mapping[str, Any]],
    kitchen_basics: KitchenBasics,
) -> JudgeResult:
    """Grade ``recipe`` with one provider call.

    The call runs under the provider's default deadline. Blank answers in
    ``preferences`` are dropped, so the judge checks only what the cook
    actually said.

    Args:
        provider: The model the judge runs on.
        recipe: The recipe the pipeline returned, with real food ids.
        preferences: The cook's answers, keyed by preference question.
        kitchen: The foods the recipe could use, each with ``id``, ``name``,
            ``quantity`` and ``unit``, as the pipeline's usable items carry
            them. Other keys are not sent.
        kitchen_basics: The staples the recipe may use without stock.

    Returns:
        The judge's checks and violations.

    Raises:
        ProviderError: When the call fails, its output doesn't fit
            ``JudgeResult``, or it doesn't answer every stated preference
            exactly once.
    """
    template = load_prompt("judge_recipe")
    stated = {key: value for key, value in preferences.items() if value.strip()}
    payload = {
        "preferences": stated,
        "kitchen": [
            {key: item[key] for key in ("id", "name", "quantity", "unit")}
            for item in kitchen
        ],
        "kitchen_basics": list(kitchen_basics.names),
        "recipe": recipe.model_dump(mode="json"),
    }
    result = await provider.generate(
        json.dumps(payload, default=str),
        response_model=JudgeResult,
        system_instruction=template.system,
        thinking=template.thinking,
    )
    answered = [check.preference for check in result.preference_checks]
    if sorted(answered) != sorted(stated):
        raise ProviderError(
            "Judge must answer every stated preference exactly once: "
            f"asked {list(stated)}, answered {answered}"
        )
    return result
