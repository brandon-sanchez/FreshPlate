"""Run an eval as a named LangSmith experiment.

The pipeline runs as the experiment's target, so each case's trace holds
its graph run, and the judge runs as the experiment's evaluator. Every
experiment on the same cases shares one LangSmith dataset, so runs
line up in LangSmith's comparison view.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Mapping, Sequence
from typing import Any, NamedTuple

from langsmith import Client, aevaluate, traceable

from app.ai.eval.cases import EvalCase
from app.ai.eval.runner import (
    CaseResult,
    EvalSetup,
    PipelineOutput,
    RecipeScore,
    run_pipeline,
    score_output,
)
from app.ai.eval.scorecard import CaseRow, case_row

_DATASET_PREFIX = "freshplate-recipe-eval"


class LoggedExperiment(NamedTuple):
    """A finished LangSmith experiment and the results it logged.

    Attributes:
        results: One result per case, in dataset order.
        name: The experiment's full name, with LangSmith's suffix.
        url: The experiment's link, or None when LangSmith gave none.
    """

    results: list[CaseResult]
    name: str
    url: str | None


class ExperimentError(RuntimeError):
    """The experiment couldn't produce a result for every case.

    Raised for harness failures, such as an evaluator that crashed or a
    LangSmith dataset whose example count doesn't match the cases. A
    pipeline failure is a scored result and never raises this.
    """


async def evaluate_in_langsmith(
    cases: Sequence[EvalCase],
    setup: EvalSetup,
    *,
    client: Client,
    experiment_prefix: str,
    metadata: Mapping[str, Any],
    concurrency: int,
) -> LoggedExperiment:
    """Run and score every case as one LangSmith experiment.

    Creates the LangSmith dataset for ``cases`` on first use. Uploads
    one traced run per case, with per-case feedback from
    ``case_feedback``.

    Args:
        cases: The cases to run. Their names must be unique.
        setup: The model and retriever to run against.
        client: The LangSmith client to upload with.
        experiment_prefix: The experiment's name. LangSmith appends a
            random suffix.
        metadata: Experiment metadata, such as the mode and prompt versions.
        concurrency: How many cases run at once.

    Returns:
        The experiment, with one result per case in ``cases`` order.

    Raises:
        ExperimentError: When a case has no run output or no scores.
    """
    dataset = ensure_dataset(client, cases)
    scores: dict[str, list[RecipeScore]] = {}

    @traceable(name="recipe_pipeline")
    async def pipeline(inputs: dict[str, Any]) -> dict[str, Any]:
        output = await run_pipeline(EvalCase.model_validate(inputs), setup)
        return output.model_dump(mode="json")

    async def judge(
        inputs: dict[str, Any], outputs: dict[str, Any]
    ) -> dict[str, list[dict[str, Any]]]:
        case = EvalCase.model_validate(inputs)
        output = PipelineOutput.model_validate(outputs)
        scores[case.name] = await score_output(case, output, setup)
        row = case_row(
            CaseResult(name=case.name, output=output, scores=scores[case.name])
        )
        return {"results": case_feedback(row)}

    experiment = await aevaluate(
        pipeline,
        data=dataset,
        evaluators=[judge],
        experiment_prefix=experiment_prefix,
        description="FreshPlate recipe pipeline over the eval dataset",
        metadata=dict(metadata),
        max_concurrency=concurrency,
        client=client,
    )
    outputs: dict[str, PipelineOutput] = {}
    async for row in experiment:
        name = row["example"].inputs["name"]
        if row["run"].error is None and row["run"].outputs is not None:
            outputs[name] = PipelineOutput.model_validate(row["run"].outputs)
    missing = [c.name for c in cases if c.name not in outputs or c.name not in scores]
    if missing:
        raise ExperimentError(f"Experiment has no result for cases: {missing}")
    results = [
        CaseResult(name=c.name, output=outputs[c.name], scores=scores[c.name])
        for c in cases
    ]
    return LoggedExperiment(results, experiment.experiment_name, experiment.url)


def dataset_name(cases: Sequence[EvalCase]) -> str:
    """Return the LangSmith dataset name for exactly these cases.

    The name ends in a hash of the cases, so editing them starts a new
    LangSmith dataset instead of comparing runs on different cases.
    """
    content = json.dumps(
        [case.model_dump(mode="json") for case in cases], sort_keys=True
    ).encode()
    return f"{_DATASET_PREFIX}-{hashlib.sha256(content).hexdigest()[:12]}"


def ensure_dataset(client: Client, cases: Sequence[EvalCase]) -> str:
    """Return the LangSmith dataset for ``cases``, creating it if new.

    Raises:
        ExperimentError: When the dataset exists but its example count
            differs from ``cases``, such as after an interrupted upload.
            Delete it in LangSmith and run again.
    """
    name = dataset_name(cases)
    if client.has_dataset(dataset_name=name):
        count = sum(1 for _ in client.list_examples(dataset_name=name))
        if count != len(cases):
            raise ExperimentError(
                f"LangSmith dataset {name} has {count} examples, expected "
                f"{len(cases)}; delete it and run again"
            )
        return name
    dataset = client.create_dataset(
        name, description="FreshPlate recipe eval cases from dataset.json"
    )
    client.create_examples(
        dataset_id=dataset.id,
        examples=[
            {"inputs": case.model_dump(mode="json"), "metadata": {"case": case.name}}
            for case in cases
        ],
    )
    return name


def case_feedback(row: CaseRow) -> list[dict[str, Any]]:
    """Return one case's LangSmith feedback from its scorecard row.

    A score the case has no value for, such as alignment for a case with no
    recipes, is left out.
    """
    feedback: list[dict[str, Any]] = [
        {"key": "recipes", "score": row.recipes, "comment": row.error},
        {"key": "pipeline_seconds", "score": row.seconds},
        {"key": "coverage", "score": row.coverage},
        {"key": "completeness", "score": row.completeness},
        {"key": "mapping_validity", "score": row.mapping_validity},
        {
            "key": "preference_alignment",
            "score": row.preference_alignment,
            "comment": _missed(row.unmet_preferences),
        },
    ]
    if row.recipes > row.judge_failures:
        feedback.append(
            {
                "key": "quantity_violations",
                "score": len(row.quantity_violations),
                "comment": "; ".join(row.quantity_violations) or None,
            }
        )
    if row.judge_failures:
        feedback.append({"key": "judge_failures", "score": row.judge_failures})
    return [item for item in feedback if item["score"] is not None]


def _missed(preferences: Sequence[str]) -> str | None:
    return f"missed {', '.join(preferences)}" if preferences else None
