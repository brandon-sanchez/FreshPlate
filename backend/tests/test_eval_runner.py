import asyncio
from typing import Any

import pytest

from app.ai.agents.meal_quality import MealCheck
from app.ai.agents.models import RecipeGenerationResponse
from app.ai.agents.photos import PHOTO_RESERVE_SECONDS
from app.ai.eval.cases import load_cases
from app.ai.eval.judge import JudgeResult
from app.ai.eval.offline import OfflineModel, OfflineRetriever
from app.ai.eval.runner import EvalSetup, evaluate_cases
from app.ai.eval.scorecard import Scorecard
from app.ai.llm.errors import ProviderError
from app.ai.llm.providers import FakeProvider
from app.core.config import settings

TOMATO_PASTA = load_cases()[0]


class ScriptedModel:
    def __init__(self, case, *, generation: Any = None, judge: Any = None) -> None:
        self._offline = OfflineModel(case)
        self._generation = generation
        self._judge = judge
        self.calls: list[type] = []

    async def generate(self, prompt, *, response_model, **kwargs):
        self.calls.append(response_model)
        if response_model is JudgeResult:
            override = self._judge
        elif issubclass(response_model, RecipeGenerationResponse):
            override = self._generation
        else:
            override = None
        if override is None:
            return await self._offline.generate(
                prompt, response_model=response_model, **kwargs
            )
        return await FakeProvider([override]).generate(
            prompt, response_model=response_model, **kwargs
        )


def setup_with(model: ScriptedModel) -> EvalSetup:
    return EvalSetup(model_for=lambda case: model, retriever=OfflineRetriever())


def judge_answer(met: dict[str, bool], violations: list[str]) -> dict:
    return {
        "preference_checks": [
            {"preference": key, "reasoning": "Reason.", "met": value}
            for key, value in met.items()
        ],
        "quantity_reasoning": "Checked.",
        "quantity_violations": violations,
    }


async def evaluate_one(model: ScriptedModel):
    [result] = await evaluate_cases([TOMATO_PASTA], setup_with(model), concurrency=1)
    return result


@pytest.mark.asyncio
async def test_offline_run_returns_a_fully_scored_recipe_for_every_case():
    cases = load_cases()
    setup = EvalSetup(model_for=OfflineModel, retriever=OfflineRetriever())

    results = await evaluate_cases(cases, setup, concurrency=4)

    assert [result.name for result in results] == [case.name for case in cases]
    scorecard = Scorecard.from_results(results, mode="offline")
    assert scorecard.cases_with_recipes == len(cases)
    assert scorecard.cases_failed == 0
    assert scorecard.coverage == 100
    assert scorecard.completeness == 100
    assert scorecard.mapping_validity == 100
    assert scorecard.preference_alignment == 100
    assert scorecard.quantity_violation_rate == 0


@pytest.mark.asyncio
async def test_each_case_runs_the_first_feed_page_batch_of_five():
    model = ScriptedModel(TOMATO_PASTA)

    await evaluate_one(model)

    generation_calls = [
        c for c in model.calls if issubclass(c, RecipeGenerationResponse)
    ]
    assert len(generation_calls) == 5


@pytest.mark.asyncio
async def test_judge_misses_and_violations_reach_the_recipe_score():
    model = ScriptedModel(
        TOMATO_PASTA,
        judge=judge_answer(
            {"meal": True, "cuisine": False, "occasion": True}, ["2 kg salt"]
        ),
    )

    result = await evaluate_one(model)

    [score] = result.scores
    assert score.preference_alignment == 67
    assert score.unmet_preferences == ["cuisine"]
    assert score.quantity_violations == ["2 kg salt"]


@pytest.mark.asyncio
async def test_a_pipeline_failure_is_a_scored_result_not_a_crash():
    model = ScriptedModel(TOMATO_PASTA, generation=ProviderError("quota"))

    result = await evaluate_one(model)

    assert result.scores == []
    assert result.output.error is not None
    assert "ProviderError" in result.output.error
    scorecard = Scorecard.from_results([result], mode="offline")
    assert scorecard.cases_failed == 1
    assert scorecard.cases_with_recipes == 0
    assert scorecard.preference_alignment is None


@pytest.mark.asyncio
async def test_a_judge_failure_is_kept_out_of_the_judged_metrics():
    model = ScriptedModel(TOMATO_PASTA, judge=ProviderError("judge down"))

    result = await evaluate_one(model)

    [score] = result.scores
    assert score.judge_error is not None
    assert score.preference_alignment is None
    assert score.coverage == 100
    scorecard = Scorecard.from_results([result], mode="offline")
    assert scorecard.judge_failures == 1
    assert scorecard.preference_alignment is None
    assert scorecard.quantity_violation_rate is None
    assert scorecard.coverage == 100


@pytest.mark.asyncio
async def test_a_harness_bug_fails_the_run():
    class BrokenRetriever:
        async def search(self, query, **kwargs):
            raise RuntimeError("bug")

    setup = EvalSetup(model_for=OfflineModel, retriever=BrokenRetriever())

    with pytest.raises(RuntimeError, match="bug"):
        await evaluate_cases([TOMATO_PASTA], setup, concurrency=1)


class SlowReviewModel:
    """The offline model, writing a different dish per call, whose reviews
    after the first run until their deadline and then fail."""

    def __init__(self, case) -> None:
        self._offline = OfflineModel(case)
        self._dishes = 0
        self._reviews = 0

    async def generate(self, prompt, *, response_model, deadline=None, **kwargs):
        answer = await self._offline.generate(
            prompt, response_model=response_model, deadline=deadline, **kwargs
        )
        if issubclass(response_model, RecipeGenerationResponse):
            self._dishes += 1
            [recipe] = answer.recipes
            title = f"Dish number {self._dishes}"
            return answer.model_copy(
                update={"recipes": [recipe.model_copy(update={"title": title})]}
            )
        if response_model is MealCheck:
            self._reviews += 1
            if self._reviews > 1:
                await asyncio.sleep(deadline.remaining_seconds)
                raise ProviderError("Gemini pipeline deadline exhausted")
        return answer


@pytest.mark.asyncio
async def test_a_review_still_running_at_the_deadline_drops_only_its_recipe(
    monkeypatch,
):
    monkeypatch.setattr(
        settings, "recipe_feed_initial_budget_seconds", PHOTO_RESERVE_SECONDS + 1
    )
    model = SlowReviewModel(TOMATO_PASTA)

    result = await evaluate_one(model)

    assert result.output.error is None
    assert len(result.scores) == 1
