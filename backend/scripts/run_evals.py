"""Run the local recipe evaluation dataset."""

from __future__ import annotations

import argparse
import asyncio
import json
import math
from pathlib import Path
from typing import Any

from app.ai.agents.graph import build_recipe_graph
from app.ai.agents.meal_quality import MealAssessment
from app.ai.agents.models import Recipe, RecipeIngredient
from app.ai.eval.judge import JudgeResult, judge_recipe
from app.ai.eval.scorers import completeness_percent, ingredient_coverage_percent
from app.ai.llm.providers import FakeProvider, GeminiProvider
from app.ai.rag.vector_store import RetrievedRecipe

DATASET = Path(__file__).parents[1] / "app/ai/eval/dataset.json"


def _fixture_recipe(case: dict[str, Any]) -> Recipe:
    """Build a recipe whose tracked ingredient maps to the case inventory."""
    inventory = case["inventory"]
    item = inventory[0]
    return Recipe(
        title=case["name"].title(),
        cook_time_minutes=20,
        servings=2,
        ingredients=[
            RecipeIngredient(
                name=item["name"],
                inventory_item_id=item["id"],
                use_amount=1,
                unit=item["unit"],
            ),
        ],
        steps=["Prepare the ingredients.", "Cook until tender.", "Serve warm."],
    )


def _offline_judgement() -> JudgeResult:
    """Provide deterministic scoring for the offline smoke benchmark."""
    return JudgeResult(
        preference_alignment=100,
        rationale="Deterministic offline fixture.",
    )


async def run(mode: str, experiment: str) -> dict[str, float | int | str]:
    """Run deterministic offline scoring or the configured live experiment."""
    cases = json.loads(DATASET.read_text(encoding="utf-8"))
    if mode == "live":
        return await _run_live(cases, experiment)

    class FixtureRetriever:
        async def search(self, query: str, **kwargs: Any) -> list[RetrievedRecipe]:
            """Return one deterministic grounding document for a fixture query."""
            del kwargs
            return [RetrievedRecipe(id=1, title=query, content=query, similarity=1.0)]

    rows: list[dict[str, Any]] = []
    for index, case in enumerate(cases):
        rejected = index in {0, len(cases) - 1}
        recipe = _fixture_recipe(case)
        assessment = MealAssessment.model_validate(
            {
                "decisions": [
                    {
                        "candidate_index": 0,
                        "verdict": "insufficient" if rejected else "eligible",
                        "reason": "Intentional deterministic rejection"
                        if rejected
                        else "Grounded offline fixture",
                    }
                ]
            }
        )
        responses: list[dict[str, Any]] = []
        for _ in range(4):
            responses.extend(
                [
                    {"recipes": [recipe.model_dump()]},
                    assessment.model_dump(),
                ]
            )
        provider = FakeProvider(responses)
        graph = build_recipe_graph(provider, FixtureRetriever())
        result = await graph.ainvoke(
            {
                "inventory": case["inventory"],
                "preferences": {"request": case["name"]},
                "batch_ceiling": 1,
            }
        )
        recipes = result.get("valid_recipes", [])
        if not recipes:
            rows.append({"name": case["name"], "error": "no valid recipe"})
            continue
        recipe = recipes[0]
        judge = _offline_judgement()
        rows.append(
            {
                "name": case["name"],
                "coverage": ingredient_coverage_percent(recipe, case["inventory"]),
                "completeness": completeness_percent(recipe),
                "preference": judge.preference_alignment,
                "violations": len(judge.quantity_violations),
            }
        )
    successful_rows = [row for row in rows if "coverage" in row]
    scorecard = {
        "experiment": experiment,
        "judge_mode": "synthetic",
        "cases": len(rows),
        "succeeded_cases": len(successful_rows),
        "failed_cases": len(rows) - len(successful_rows),
        "coverage": round(
            sum(r["coverage"] for r in successful_rows) / len(successful_rows), 1
        )
        if successful_rows
        else 0.0,
        "completeness": round(
            sum(r["completeness"] for r in successful_rows) / len(successful_rows), 1
        )
        if successful_rows
        else 0.0,
        "preference": round(
            sum(r["preference"] for r in successful_rows) / len(successful_rows), 1
        )
        if successful_rows
        else 0.0,
        "quantity_violation_rate": (
            round(
                sum(bool(r["violations"]) for r in successful_rows)
                / len(successful_rows),
                3,
            )
            if successful_rows
            else 0.0
        ),
    }
    print(json.dumps(scorecard, indent=2, sort_keys=True))
    return scorecard


async def _run_live(cases: list[dict[str, Any]], experiment: str) -> dict[str, Any]:
    """Evaluate the real graph with Gemini and the production retriever."""
    from langsmith import Client

    from app.ai.rag.embeddings import EmbeddingClient
    from app.ai.rag.retriever import RecipeRetriever
    from app.ai.rag.vector_store import SupabaseVectorStore

    provider = GeminiProvider()
    retriever = RecipeRetriever(EmbeddingClient(), SupabaseVectorStore())
    graph = build_recipe_graph(provider, retriever)
    client = Client()
    dataset_name = f"{experiment}-dataset"
    existing = client.has_dataset(dataset_name=dataset_name)
    dataset = (
        client.read_dataset(dataset_name=dataset_name)
        if existing
        else client.create_dataset(dataset_name=dataset_name)
    )
    examples = (
        list(client.list_examples(dataset_id=dataset.id))
        if existing
        else [
            client.create_example(
                inputs={
                    "inventory": case["inventory"],
                    "preferences": {"request": case["name"]},
                },
                dataset_id=dataset.id,
            )
            for case in cases
        ]
    )

    async def target(inputs: dict[str, Any]) -> dict[str, Any]:
        """Adapt graph output to LangSmith's evaluator target contract."""
        result = await graph.ainvoke({**inputs, "batch_ceiling": 1})
        recipes = result.get("valid_recipes", [])
        if not recipes:
            raise ValueError("recipe pipeline returned no valid recipes")
        return {
            "recipe": recipes[0].model_dump(mode="json"),
            "inventory": inputs.get("inventory", []),
            "request": inputs.get("preferences", {}).get("request", ""),
        }

    results = await client.aevaluate(
        target,
        data=examples,
        evaluators=build_live_evaluators(provider),
        experiment_prefix=experiment,
        description="FreshPlate recipe pipeline evaluation",
        upload_results=True,
    )
    completed = []
    if hasattr(results, "__aiter__"):
        async for item in results:
            completed.append(item)
    elif isinstance(results, (list, tuple)):
        completed.extend(results)
    metrics = _aggregate_live_results(completed, expected_count=len(examples))
    url = getattr(results, "experiment_url", None) or getattr(results, "url", "")
    scorecard = {
        "experiment": experiment,
        "cases": metrics["total_cases"],
        "judge_mode": "llm",
        **metrics,
        "url": str(url),
    }
    print(json.dumps(scorecard, indent=2, sort_keys=True))
    return scorecard


def _aggregate_live_results(
    results: list[Any], expected_count: int | None = None, *, total: int | None = None
) -> dict[str, Any]:
    """Aggregate evaluator feedback while retaining failed target rows."""
    scores: dict[str, list[float]] = {
        "coverage": [],
        "completeness": [],
        "preference": [],
    }
    violations = 0
    failed = 0
    required = {"coverage", "completeness", "preference_alignment"}
    for result in results:
        run = result["run"]
        if run.error:
            failed += 1
            continue
        feedback = result.get("evaluation_results", {}).get("results", [])
        keys = [item.key for item in feedback]
        if len(keys) != len(set(keys)):
            failed += 1
            continue
        feedback_by_key = dict(zip(keys, feedback))
        if not required.issubset(feedback_by_key):
            failed += 1
            continue
        if any(
            item.score is None
            or not isinstance(item.score, (int, float))
            or isinstance(item.score, bool)
            or not math.isfinite(float(item.score))
            or not 0 <= item.score <= 100
            or (item.evaluator_info or {}).get("error")
            for item in feedback_by_key.values()
            if item.key in required
        ):
            failed += 1
            continue
        for item in feedback:
            key = item.key
            score = item.score
            score_key = "preference" if key == "preference_alignment" else key
            if score_key in scores and isinstance(score, (int, float)):
                scores[score_key].append(float(score))
            info = item.evaluator_info or {}
            if key == "preference_alignment" and info.get(
                "quantity_violation_count", 0
            ):
                violations += 1
    expected = expected_count if expected_count is not None else (total or len(results))
    incomplete = max(expected - len(results), 0)
    failed_cases = failed + incomplete
    succeeded = len(results) - failed
    return {
        "total_cases": expected,
        "succeeded_cases": succeeded,
        "failed_cases": failed_cases,
        "coverage": round(sum(scores["coverage"]) / len(scores["coverage"]), 1)
        if scores["coverage"]
        else 0.0,
        "completeness": round(
            sum(scores["completeness"]) / len(scores["completeness"]), 1
        )
        if scores["completeness"]
        else 0.0,
        "preference": round(sum(scores["preference"]) / len(scores["preference"]), 1)
        if scores["preference"]
        else 0.0,
        "quantity_violation_rate": round(violations / succeeded, 3)
        if succeeded
        else 0.0,
    }


def build_live_evaluators(provider: Any) -> list[Any]:
    """Return LangSmith evaluators for completeness, coverage, and preference."""

    def measured(
        outputs: dict[str, Any], reference_outputs: dict[str, Any] | None = None
    ) -> dict[str, Any]:
        """Score structural recipe completeness on a target output."""
        del reference_outputs
        return {
            "key": "completeness",
            "score": completeness_percent(Recipe.model_validate(outputs["recipe"])),
        }

    def coverage(
        outputs: dict[str, Any], reference_outputs: dict[str, Any] | None = None
    ) -> dict[str, Any]:
        """Score how many recipe ingredients are grounded in inventory."""
        del reference_outputs
        recipe = Recipe.model_validate(outputs["recipe"])
        return {
            "key": "coverage",
            "score": ingredient_coverage_percent(recipe, outputs.get("inventory", [])),
        }

    async def judge(
        outputs: dict[str, Any], reference_outputs: dict[str, Any] | None = None
    ) -> dict[str, Any]:
        """Run the structured LLM judge and expose its rubric metadata."""
        del reference_outputs
        result = await judge_recipe(
            provider,
            Recipe.model_validate(outputs["recipe"]),
            request=outputs["request"],
            inventory=outputs["inventory"],
        )
        return {
            "key": "preference_alignment",
            "score": result.preference_alignment,
            "comment": result.rationale,
            "evaluator_info": {
                "quantity_violation_count": len(result.quantity_violations),
                "quantity_violations": result.quantity_violations,
            },
        }

    return [measured, coverage, judge]


def main() -> None:
    """Parse CLI options and execute the selected evaluation mode."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mode", choices=("offline", "live"), default="offline")
    parser.add_argument("--experiment", default="freshplate-eval-local")
    args = parser.parse_args()
    asyncio.run(run(args.mode, args.experiment))


if __name__ == "__main__":
    main()
