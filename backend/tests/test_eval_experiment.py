from types import SimpleNamespace

import pytest
from langsmith.evaluation.evaluator import EvaluationResult

from app.ai.eval import experiment
from app.ai.eval.cases import load_cases
from app.ai.eval.experiment import (
    ExperimentError,
    case_feedback,
    ensure_dataset,
    evaluate_in_langsmith,
)
from app.ai.eval.offline import OfflineModel, OfflineRetriever
from app.ai.eval.runner import CaseResult, EvalSetup, PipelineOutput, RecipeScore
from app.ai.eval.scorecard import case_row

CASES = load_cases()[:3]


class InMemoryLangSmithClient:
    def __init__(self, existing: dict[str, list[dict]] | None = None) -> None:
        self.datasets = dict(existing or {})

    def has_dataset(self, *, dataset_name):
        return dataset_name in self.datasets

    def list_examples(self, *, dataset_name):
        return iter(self.datasets[dataset_name])

    def create_dataset(self, name, *, description):
        self.datasets[name] = []
        return SimpleNamespace(id=name)

    def create_examples(self, *, dataset_id, examples):
        self.datasets[dataset_id].extend(examples)


class FakeExperiment:
    experiment_name = "test-1a2b3c4d"
    url = "https://smith.example.test/experiment"

    def __init__(self, rows):
        self._rows = rows

    def __aiter__(self):
        return self._iterate()

    async def _iterate(self):
        for row in self._rows:
            yield row


def fake_aevaluate(client):
    async def aevaluate(target, *, data, evaluators, **kwargs):
        rows = []
        for example in client.list_examples(dataset_name=data):
            outputs = await target(example["inputs"])
            results = [
                await e(inputs=example["inputs"], outputs=outputs) for e in evaluators
            ]
            rows.append(
                {
                    "example": SimpleNamespace(inputs=example["inputs"]),
                    "run": SimpleNamespace(error=None, outputs=outputs),
                    "evaluation_results": results,
                }
            )
        return FakeExperiment(rows)

    return aevaluate


def score(**overrides):
    values = {
        "title": "Dish",
        "coverage": 100,
        "completeness": 75,
        "mapping_validity": 100,
        "preference_alignment": 50,
        "unmet_preferences": ["diet"],
        "quantity_violations": ["2 kg salt"],
    }
    return RecipeScore(**{**values, **overrides})


def row(scores, error=None):
    output = PipelineOutput(
        recipes=[], kitchen=[], kitchen_basics=[], seconds=12.345, error=error
    )
    return case_row(CaseResult(name="pasta", output=output, scores=scores))


def test_feedback_is_valid_langsmith_feedback_per_case():
    clean = score(
        preference_alignment=100, unmet_preferences=[], quantity_violations=[]
    )

    feedback = case_feedback(row([score(), clean]))

    parsed = {item["key"]: EvaluationResult.model_validate(item) for item in feedback}
    assert parsed["recipes"].score == 2
    assert parsed["completeness"].score == 75
    assert parsed["preference_alignment"].score == 75
    assert parsed["preference_alignment"].comment == "missed diet"
    assert parsed["quantity_violations"].score == 1
    assert parsed["quantity_violations"].comment == "2 kg salt"
    assert parsed["pipeline_seconds"].score == 12.3
    assert "judge_failures" not in parsed


def test_a_case_with_no_recipes_reports_its_error():
    feedback = case_feedback(row([], error="TimeoutError: deadline"))

    assert {item["key"] for item in feedback} == {"recipes", "pipeline_seconds"}
    assert feedback[0]["comment"] == "TimeoutError: deadline"


def test_judge_failures_are_reported_without_judge_scores():
    failed = score(
        preference_alignment=None,
        unmet_preferences=[],
        quantity_violations=[],
        judge_error="down",
    )

    keys = {item["key"]: item["score"] for item in case_feedback(row([failed]))}

    assert keys["judge_failures"] == 1
    assert "preference_alignment" not in keys
    assert "quantity_violations" not in keys


def test_dataset_is_created_once_and_reused():
    client = InMemoryLangSmithClient()

    name = ensure_dataset(client, CASES)
    again = ensure_dataset(client, CASES)

    assert name == again
    assert name.startswith("freshplate-recipe-eval-")
    assert name != ensure_dataset(InMemoryLangSmithClient(), load_cases())
    assert [ex["inputs"]["name"] for ex in client.datasets[name]] == [
        c.name for c in CASES
    ]


def test_a_partly_uploaded_dataset_is_refused():
    client = InMemoryLangSmithClient()
    name = ensure_dataset(client, CASES)
    client.datasets[name].pop()

    with pytest.raises(ExperimentError, match="delete it"):
        ensure_dataset(client, CASES)


@pytest.mark.asyncio
async def test_experiment_results_match_a_local_run(monkeypatch):
    client = InMemoryLangSmithClient()
    monkeypatch.setattr(experiment, "aevaluate", fake_aevaluate(client))
    setup = EvalSetup(model_for=OfflineModel, retriever=OfflineRetriever())

    logged = await evaluate_in_langsmith(
        CASES,
        setup,
        client=client,
        experiment_prefix="test",
        metadata={},
        concurrency=1,
    )

    assert logged.name == "test-1a2b3c4d"
    assert logged.url == FakeExperiment.url
    assert [r.name for r in logged.results] == [c.name for c in CASES]
    assert all(r.scores[0].preference_alignment == 100 for r in logged.results)
