"""Tests for the structured judge and credential-free runner."""

import json
import os
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest
from langsmith.evaluation.evaluator import EvaluationResult

from app.ai.agents.models import Recipe, RecipeIngredient
from app.ai.eval.judge import judge_recipe
from app.ai.llm.providers import FakeProvider
from scripts.run_evals import (
    _aggregate_live_results,
    _fixture_recipe,
    build_live_evaluators,
    run,
)


def sample_recipe() -> Recipe:
    return Recipe(
        title="Tomato Pasta",
        cook_time_minutes=20,
        servings=2,
        ingredients=[RecipeIngredient(name="tomato", unit="each", use_amount=1)],
        steps=["Cook", "Serve"],
    )


@pytest.mark.asyncio
async def test_judge_accepts_valid_structured_output():
    result = await judge_recipe(
        FakeProvider(
            [
                {
                    "preference_alignment": 90,
                    "quantity_violations": [],
                    "rationale": "Matches the requested dish.",
                }
            ]
        ),
        sample_recipe(),
        request="tomato pasta",
        inventory=[],
    )
    assert result.preference_alignment == 90
    assert result.passed


@pytest.mark.asyncio
async def test_judge_rejects_invalid_structured_output():
    with pytest.raises(Exception, match="invalid structured output"):
        await judge_recipe(
            FakeProvider([{"preference_alignment": 101}]),
            sample_recipe(),
            request="tomato pasta",
            inventory=[],
        )


@pytest.mark.asyncio
async def test_offline_runner_scores_all_dataset_cases_without_credentials(capsys):
    scorecard = await run("offline", "test-offline")
    assert scorecard["cases"] == 22
    assert scorecard["experiment"] == "test-offline"
    assert scorecard["judge_mode"] == "synthetic"
    assert json.loads(capsys.readouterr().out)["coverage"] == 0.0


def test_documented_offline_command_reports_22_cases():
    backend = Path(__file__).parents[1]
    env = {
        key: value
        for key, value in os.environ.items()
        if key not in {"GEMINI_API_KEY", "LANGSMITH_API_KEY"}
    }
    env["PYTHONPATH"] = str(backend)
    result = subprocess.run(
        [sys.executable, "-m", "scripts.run_evals", "--mode", "offline"],
        cwd=backend,
        env=env,
        check=True,
        capture_output=True,
        text=True,
    )
    scorecard = json.loads(result.stdout)
    assert scorecard["cases"] == 22
    assert scorecard["judge_mode"] == "synthetic"


def test_each_case_has_an_independent_fixture_response():
    cases = json.loads(
        (Path(__file__).parents[1] / "app/ai/eval/dataset.json").read_text()
    )
    fixtures = [_fixture_recipe(case) for case in cases]
    assert [recipe.title for recipe in fixtures] == [
        case["name"].title() for case in cases
    ]
    assert all(
        recipe.ingredients[0].name == case["inventory"][0]["name"]
        for recipe, case in zip(fixtures, cases)
    )


@pytest.mark.asyncio
async def test_live_evaluators_match_langsmith_schema():
    outputs = {
        "recipe": sample_recipe()
        .model_copy(
            update={
                "ingredients": [
                    sample_recipe()
                    .ingredients[0]
                    .model_copy(update={"inventory_item_id": "t"})
                ]
            }
        )
        .model_dump(mode="json"),
        "inventory": [{"id": "t", "quantity": 2}],
        "request": "tomato pasta",
    }
    evaluators = build_live_evaluators(
        FakeProvider(
            [
                {
                    "preference_alignment": 87,
                    "rationale": "Good match",
                    "quantity_violations": ["too much"],
                }
            ]
        )
    )
    results = [
        evaluators[0](outputs),
        evaluators[1](outputs),
        await evaluators[2](outputs),
    ]
    parsed = [EvaluationResult.model_validate(result) for result in results]
    assert parsed[0].score == 100
    assert parsed[1].score == 100
    assert parsed[2].score == 87
    assert parsed[2].comment == "Good match"
    assert parsed[2].evaluator_info["quantity_violation_count"] == 1


def test_live_scorecard_aggregates_mixed_completed_and_failed_rows():
    results = [
        {
            "run": SimpleNamespace(error=None),
            "evaluation_results": {
                "results": [
                    EvaluationResult(key="coverage", score=40),
                    EvaluationResult(key="completeness", score=80),
                    EvaluationResult(
                        key="preference_alignment",
                        score=60,
                        evaluator_info={"quantity_violation_count": 1},
                    ),
                ]
            },
        },
        {
            "run": SimpleNamespace(error=None),
            "evaluation_results": {
                "results": [
                    EvaluationResult(key="coverage", score=100),
                    EvaluationResult(key="completeness", score=100),
                    EvaluationResult(
                        key="preference_alignment",
                        score=90,
                        evaluator_info={"quantity_violation_count": 0},
                    ),
                ]
            },
        },
        {
            "run": SimpleNamespace(error="pipeline failed"),
            "evaluation_results": {"results": []},
        },
    ]
    scorecard = _aggregate_live_results(results, total=3)
    assert scorecard == {
        "total_cases": 3,
        "succeeded_cases": 2,
        "failed_cases": 1,
        "coverage": 70.0,
        "completeness": 90.0,
        "preference": 75.0,
        "quantity_violation_rate": 0.5,
    }


def test_offline_cli_emits_numeric_machine_readable_scorecard():
    backend = Path(__file__).parents[1]
    result = subprocess.run(
        [sys.executable, "-m", "scripts.run_evals", "--mode", "offline"],
        cwd=backend,
        env={**os.environ, "PYTHONPATH": str(backend)},
        check=True,
        capture_output=True,
        text=True,
    )
    scorecard = json.loads(result.stdout)
    assert all(
        isinstance(scorecard[key], (int, float))
        for key in ("coverage", "completeness", "preference", "violation_rate")
    )
