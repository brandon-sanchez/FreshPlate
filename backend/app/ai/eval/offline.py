"""Deterministic stand-ins for Gemini and vector search, so evals run for free.

Offline evals exercise the whole harness: the real graph, the code checks,
the scorers, the judge's validation and the scorecard. The recipes are
fixtures, so offline scores show that the harness works, not that the
recipes are good.
"""

from __future__ import annotations

import json
from typing import Any

from pydantic import BaseModel

from app.ai.agents.food_labels import FoodLabels
from app.ai.agents.meal_quality import MealCheck
from app.ai.agents.models import (
    Recipe,
    RecipeGenerationResponse,
    RecipeIngredient,
    RecipeStep,
)
from app.ai.agents.nodes import analyze_inventory
from app.ai.eval.cases import DEFAULT_KITCHEN_BASICS, EvalCase
from app.ai.eval.judge import JudgeResult
from app.ai.llm.errors import ProviderError
from app.ai.llm.protocol import ResponseModel, ThinkingLevel
from app.ai.llm.providers import FakeProvider
from app.ai.llm.retry import PipelineDeadline
from app.ai.rag.vector_store import RetrievedRecipe
from app.inventory.food_facts import FoodLine


class OfflineModel:
    """A provider that answers one case's calls the way a perfect model would.

    Every generation call gets the case's fixture recipe, every meal review
    keeps it, and every judge call says each stated preference is met with
    no quantity violations, reading the preferences from the judge's
    prompt. Answers go through ``FakeProvider``, so they are
    validated exactly as a real response would be.
    """

    def __init__(self, case: EvalCase) -> None:
        self._recipe = _fixture_recipe(case)

    async def generate(
        self,
        prompt: str,
        *,
        response_model: type[ResponseModel],
        system_instruction: str | None = None,
        deadline: PipelineDeadline | None = None,
        thinking: ThinkingLevel | None = None,
    ) -> ResponseModel:
        """Return this case's answer for the kind of call ``response_model`` is.

        Raises:
            ProviderError: When the call is of a kind the offline model has
                no answer for, so a new pipeline call fails loudly instead of
                getting a wrong answer.
        """
        return await FakeProvider([self._answer(prompt, response_model)]).generate(
            prompt,
            response_model=response_model,
            system_instruction=system_instruction,
            deadline=deadline,
            thinking=thinking,
        )

    def _answer(self, prompt: str, response_model: type[BaseModel]) -> dict[str, Any]:
        if issubclass(response_model, RecipeGenerationResponse):
            return {"recipes": [self._recipe]}
        if response_model is MealCheck:
            return {
                "main_component": "The offline fixture's food",
                "dish_reasoning": "An offline fixture meal",
                "portion_reasoning": "The whole stock of one food",
                "unlisted_foods": [],
                "is_requested_dish": True,
                "realistic_portions": True,
                "coherent_method": True,
            }
        if response_model is JudgeResult:
            return {
                "preference_checks": [
                    {"preference": key, "reasoning": "Offline fixture.", "met": True}
                    for key in json.loads(prompt)["preferences"]
                ],
                "quantity_reasoning": "Offline fixture.",
                "quantity_violations": [],
            }
        raise ProviderError(f"OfflineModel has no answer for {response_model.__name__}")


class OfflineRetriever:
    """A retriever that returns one grounding document echoing the query."""

    async def search(
        self,
        query: str,
        *,
        limit: int,
        match_threshold: float,
        deadline: PipelineDeadline | None,
    ) -> list[RetrievedRecipe]:
        """Return one document whose title and content are the query."""
        del limit, match_threshold, deadline
        return [RetrievedRecipe(id=1, title=query, content=query, similarity=1.0)]


def _fixture_recipe(case: EvalCase) -> dict[str, Any]:
    """Return a recipe of all of the case's first usable food, as Gemini writes it.

    Foods are named by their prompt labels, as in a real generation answer.
    Using the whole stock gives a meal-sized portion, so the code portion
    checks pass the recipe on to the meal review.
    """
    analysis = analyze_inventory(
        {
            "inventory": [line.model_dump() for line in case.inventory],
            "kitchen_basics": DEFAULT_KITCHEN_BASICS,
        }
    )
    usable = analysis["usable_items"]
    food = FoodLine.model_validate(usable[0]["food"])
    label = FoodLabels(
        (item["id"] for item in usable), analysis["kitchen_basics"]
    ).label(food.id)
    recipe = Recipe(
        title=case.name.title(),
        headnote="A deterministic offline fixture.",
        cook_time_minutes=20,
        servings=2,
        active_minutes=10,
        total_minutes=20,
        equipment=["large skillet"],
        ingredients=[
            RecipeIngredient(
                name=food.name,
                inventory_item_id=label,
                use_amount=food.available,
                unit=food.stock_unit,
            )
        ],
        steps=[
            RecipeStep(instruction="Prepare the ingredients", uses=[label]),
            RecipeStep(
                instruction="Cook\nCook over medium heat.",
                doneness_cue="Ready when tender.",
                minutes=10,
            ),
            RecipeStep(instruction="Serve warm."),
        ],
    )
    return recipe.model_dump(mode="json")
