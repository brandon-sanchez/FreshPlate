"""Run the recipe pipeline over eval cases and score what it returns.

Each case runs the graph the app's first feed page runs, with the same batch
size, quality-retry rule, retrieval pool and recipe time budget, but without
the photo step, so an eval makes no image calls.
"""

from __future__ import annotations

import asyncio
import time
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict
from pydantic_core import to_jsonable_python

from app.ai.agents.graph import build_recipe_graph
from app.ai.agents.kitchen_basics import KitchenBasics
from app.ai.agents.models import Recipe
from app.ai.agents.nodes import RecipeRetrieverPort
from app.ai.agents.photos import PHOTO_RESERVE_SECONDS
from app.ai.eval.cases import DEFAULT_KITCHEN_BASICS, EvalCase
from app.ai.eval.judge import JudgeResult, judge_recipe
from app.ai.eval.scorers import (
    completeness_percent,
    ingredient_coverage_percent,
    mapping_validity_percent,
)
from app.ai.llm.errors import ProviderError
from app.ai.llm.protocol import LLMProvider
from app.ai.llm.retry import PipelineDeadline
from app.ai.prompts.loader import load_prompt
from app.ai.prompts.tracing import build_trace_config
from app.api.recipes import (
    RECIPE_FEED_INITIAL_HEAD_BATCH_CEILING,
    RECIPE_FEED_INITIAL_QUALITY_RETRY_LIMIT,
    RECIPE_FEED_INITIAL_RETRY_ONLY_WHEN_EMPTY,
    RECIPE_FEED_RETRIEVAL_POOL_LIMIT,
)
from app.core.config import settings

EvalMode = Literal["offline", "live"]
"""Offline runs on fixtures for free; live calls Gemini and vector search."""

_PIPELINE_TIMEOUT = "Recipe pipeline deadline exhausted"


@dataclass(frozen=True)
class EvalSetup:
    """The model and retriever one eval run talks to.

    Attributes:
        model_for: Returns the provider for a case. The pipeline and the
            judge both use it.
        retriever: The grounding search the pipeline's retrieve step uses.
    """

    model_for: Callable[[EvalCase], LLMProvider]
    retriever: RecipeRetrieverPort


class PipelineOutput(BaseModel):
    """What the pipeline returned for one case, in JSON-safe form.

    Attributes:
        recipes: The recipes that passed every in-flow check, which are the
            cards a cook would see.
        kitchen: The pipeline's usable items in JSON form, each with
            ``id``, ``name``, ``quantity`` and ``unit`` in its stock unit,
            and the food's ``FoodLine`` fields under ``food``.
        kitchen_basics: The basics the recipes could use.
        seconds: Wall time from invoking the graph to its result or failure.
        error: Why the run returned nothing, such as an exhausted deadline,
            or None when it finished. A cook would see "AI unavailable".
    """

    model_config = ConfigDict(extra="forbid")

    recipes: list[Recipe]
    kitchen: list[dict[str, Any]]
    kitchen_basics: list[str]
    seconds: float
    error: str | None = None


class RecipeScore(BaseModel):
    """Every score for one returned recipe.

    Attributes:
        title: The recipe's title.
        coverage: Percentage of non-basic ingredients mapped to a kitchen
            food, the number the app shows as the match.
        completeness: Percentage of structural checks passed.
        mapping_validity: Percentage of mapped ingredients whose food exists
            and whose amount is positive and within stock.
        preference_alignment: Percentage of stated preferences the judge
            says are met, or None when the judge failed or the case stated
            no preference.
        unmet_preferences: The preference keys the judge says are not met.
        quantity_violations: The judge's gross or implausible amounts.
        judge_error: Why the judge failed for this recipe, or None.
    """

    model_config = ConfigDict(extra="forbid")

    title: str
    coverage: int
    completeness: int
    mapping_validity: int
    preference_alignment: int | None
    unmet_preferences: list[str]
    quantity_violations: list[str]
    judge_error: str | None = None


class CaseResult(BaseModel):
    """One case's pipeline output and the scores of each recipe in it."""

    model_config = ConfigDict(extra="forbid")

    name: str
    output: PipelineOutput
    scores: list[RecipeScore]


async def run_pipeline(case: EvalCase, setup: EvalSetup) -> PipelineOutput:
    """Run the first-feed-page graph on one case.

    A provider failure or an exhausted deadline is a result, not an error:
    it is returned in ``PipelineOutput.error`` because it is what the cook
    would get. Any other exception is a harness bug and propagates.
    """
    prompt = load_prompt("generate_recipes")
    graph = build_recipe_graph(
        setup.model_for(case),
        setup.retriever,
        prompt=prompt,
        quality_retry_limit=RECIPE_FEED_INITIAL_QUALITY_RETRY_LIMIT,
        retry_only_when_no_valid=RECIPE_FEED_INITIAL_RETRY_ONLY_WHEN_EMPTY,
        retrieval_limit=RECIPE_FEED_RETRIEVAL_POOL_LIMIT,
    )
    # Mirrors post_recipe_feed_session: the request deadline bounds the whole
    # run, and the recipe steps stop PHOTO_RESERVE_SECONDS earlier, as the
    # feed's graph does to leave its photo step time. A step that is still
    # running then drops only its own recipe.
    request_deadline = PipelineDeadline.from_now(
        settings.recipe_feed_initial_budget_seconds
    )
    state = {
        "inventory": [line.model_dump(mode="python") for line in case.inventory],
        "kitchen_basics": DEFAULT_KITCHEN_BASICS,
        "preferences": dict(case.preferences),
        "exclude_titles": [],
        "batch_ceiling": RECIPE_FEED_INITIAL_HEAD_BATCH_CEILING,
        "metadata": {"eval_case": case.name},
        "deadline": request_deadline.ending_before(PHOTO_RESERVE_SECONDS),
    }
    started = time.monotonic()
    try:
        result = await asyncio.wait_for(
            graph.ainvoke(
                state, config=build_trace_config(prompt, request_id=f"eval:{case.name}")
            ),
            timeout=request_deadline.remaining_seconds,
        )
        if request_deadline.expired:
            raise TimeoutError(_PIPELINE_TIMEOUT)
    except (ProviderError, TimeoutError) as exc:
        return PipelineOutput(
            recipes=[],
            kitchen=[],
            kitchen_basics=[],
            seconds=time.monotonic() - started,
            error=f"{type(exc).__name__}: {exc or _PIPELINE_TIMEOUT}",
        )
    return PipelineOutput(
        recipes=result.get("valid_recipes", []),
        kitchen=to_jsonable_python(result["usable_items"]),
        kitchen_basics=list(result["kitchen_basics"].names),
        seconds=time.monotonic() - started,
    )


async def score_output(
    case: EvalCase, output: PipelineOutput, setup: EvalSetup
) -> list[RecipeScore]:
    """Score each recipe in ``output`` with the code scorers and the judge.

    The judge calls for a case run concurrently. A judge failure is recorded
    on that recipe's score, so one bad call doesn't lose the case.
    """
    provider = setup.model_for(case)
    basics = KitchenBasics(output.kitchen_basics)
    judgements = await asyncio.gather(
        *(
            judge_recipe(
                provider,
                recipe,
                preferences=case.preferences,
                kitchen=output.kitchen,
                kitchen_basics=basics,
            )
            for recipe in output.recipes
        ),
        return_exceptions=True,
    )
    return [
        _recipe_score(recipe, judgement, output.kitchen, basics)
        for recipe, judgement in zip(output.recipes, judgements, strict=True)
    ]


def _recipe_score(
    recipe: Recipe,
    judgement: JudgeResult | BaseException,
    kitchen: Sequence[Mapping[str, Any]],
    basics: KitchenBasics,
) -> RecipeScore:
    if isinstance(judgement, BaseException) and not isinstance(
        judgement, ProviderError
    ):
        raise judgement
    score = RecipeScore(
        title=recipe.title,
        coverage=ingredient_coverage_percent(recipe, kitchen, basics),
        completeness=completeness_percent(recipe),
        mapping_validity=mapping_validity_percent(recipe, kitchen),
        preference_alignment=None,
        unmet_preferences=[],
        quantity_violations=[],
    )
    if isinstance(judgement, ProviderError):
        return score.model_copy(update={"judge_error": str(judgement)})
    return score.model_copy(
        update={
            "preference_alignment": judgement.preference_alignment,
            "unmet_preferences": [
                check.preference
                for check in judgement.preference_checks
                if not check.met
            ],
            "quantity_violations": judgement.quantity_violations,
        }
    )


async def evaluate_cases(
    cases: Sequence[EvalCase], setup: EvalSetup, *, concurrency: int
) -> list[CaseResult]:
    """Run and score every case locally, at most ``concurrency`` at a time.

    Returns:
        One result per case, in ``cases`` order.
    """
    limit = asyncio.Semaphore(concurrency)

    async def evaluate(case: EvalCase) -> CaseResult:
        async with limit:
            output = await run_pipeline(case, setup)
            scores = await score_output(case, output, setup)
        return CaseResult(name=case.name, output=output, scores=scores)

    return list(await asyncio.gather(*(evaluate(case) for case in cases)))
