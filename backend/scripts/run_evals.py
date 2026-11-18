"""Run the recipe evals and print a scorecard.

Usage:
    cd backend
    venv/bin/python -m scripts.run_evals            # offline, free
    venv/bin/python -m scripts.run_evals --live     # Gemini, billed

Offline mode answers every model call with fixtures, so it needs no keys
and checks the harness rather than recipe quality. Live mode runs the real
pipeline on Gemini and the production vector store, and the judge on
Gemini, and logs a named LangSmith experiment when ``LANGSMITH_API_KEY`` is
set, unless ``--no-upload`` is passed. Offline runs never upload, so fixture
scores never sit beside real ones in LangSmith. The exit
status is 0 whatever the scores are: evals inform, they don't gate.
"""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import os
import sys
from collections.abc import Sequence

from langsmith import Client

from app.ai.eval.cases import EvalCase, load_cases
from app.ai.eval.experiment import dataset_name, evaluate_in_langsmith
from app.ai.eval.offline import OfflineModel, OfflineRetriever
from app.ai.eval.runner import EvalMode, EvalSetup, evaluate_cases
from app.ai.eval.scorecard import Scorecard
from app.ai.eval.usage import recorded_gemini_calls, summarize_calls
from app.ai.llm.providers import DEFAULT_GEMINI_MODEL, GeminiProvider
from app.ai.prompts.loader import load_prompt
from app.ai.rag.embeddings import EmbeddingClient
from app.ai.rag.retriever import RecipeRetriever
from app.ai.rag.vector_store import SupabaseVectorStore
from app.api.recipes import RECIPE_FEED_INITIAL_HEAD_BATCH_CEILING
from app.core.config import settings

# Each live case makes up to five generation calls at once, then its meal
# reviews and judge calls, so two cases at a time keep about ten Gemini
# calls in flight.
_CASE_CONCURRENCY = 2


async def run(
    mode: EvalMode,
    *,
    experiment: str,
    upload: bool,
) -> Scorecard:
    """Run every case in ``mode`` and return the scorecard.

    Args:
        mode: "offline" for fixtures, "live" for Gemini and vector search.
        experiment: The LangSmith experiment's name prefix.
        upload: Whether to log the run as a LangSmith experiment. The
            caller must have configured LangSmith.

    Raises:
        EvalCaseError: When the dataset file is invalid.
        ExperimentError: When an uploaded experiment is missing a case.
    """
    cases = load_cases()
    setup = _setup(mode)
    with recorded_gemini_calls() as calls:
        if not upload:
            results = await evaluate_cases(cases, setup, concurrency=_CASE_CONCURRENCY)
            return Scorecard.from_results(
                results, mode=mode, usage=summarize_calls(calls)
            )
        logged = await evaluate_in_langsmith(
            cases,
            setup,
            client=Client(),
            experiment_prefix=experiment,
            metadata=_metadata(mode, cases),
            concurrency=_CASE_CONCURRENCY,
        )
    return Scorecard.from_results(
        logged.results,
        mode=mode,
        usage=summarize_calls(calls),
        experiment=logged.name,
        url=logged.url,
    )


def _setup(mode: EvalMode) -> EvalSetup:
    if mode == "offline":
        return EvalSetup(model_for=OfflineModel, retriever=OfflineRetriever())
    gemini = GeminiProvider()
    return EvalSetup(
        model_for=lambda case: gemini,
        retriever=RecipeRetriever(EmbeddingClient(), SupabaseVectorStore()),
    )


def _metadata(mode: EvalMode, cases: Sequence[EvalCase]) -> dict[str, str | int]:
    """Return what makes two experiments comparable: model, prompts and data."""
    return {
        "mode": mode,
        "model": DEFAULT_GEMINI_MODEL if mode == "live" else "OfflineModel",
        "batch_ceiling": RECIPE_FEED_INITIAL_HEAD_BATCH_CEILING,
        "dataset": dataset_name(cases),
        **{
            f"{name}_prompt_version": load_prompt(name).version
            for name in ("generate_recipes", "assess_meals", "judge_recipe")
        },
    }


def _export_langsmith_settings() -> None:
    """Copy LangSmith settings from ``backend/.env`` into the environment.

    The LangSmith client and LangGraph's tracer read only the process
    environment. A variable the shell already set wins.
    """
    values = {
        "LANGSMITH_API_KEY": settings.langsmith_api_key,
        "LANGSMITH_ENDPOINT": settings.langsmith_endpoint,
        "LANGSMITH_PROJECT": settings.langsmith_project,
        "LANGSMITH_TRACING": "true",
    }
    for name, value in values.items():
        if value:
            os.environ.setdefault(name, value)


def _live_configured() -> bool:
    return bool(
        settings.gemini_api_key
        and settings.supabase_url
        and (settings.supabase_publishable_key or settings.supabase_anon_key)
    )


def main(argv: Sequence[str] | None = None) -> None:
    """Parse options, run the evals and print the scorecard."""
    parser = argparse.ArgumentParser(
        description="Run the FreshPlate recipe evals and print a scorecard."
    )
    parser.add_argument(
        "--live",
        action="store_true",
        help="run on Gemini and the production vector store (billed)",
    )
    parser.add_argument(
        "--experiment",
        default="freshplate-live",
        help="LangSmith experiment name for a live run (default: freshplate-live)",
    )
    parser.add_argument(
        "--no-upload",
        action="store_true",
        help="run live without logging a LangSmith experiment",
    )
    parser.add_argument(
        "--json", action="store_true", help="print the scorecard as JSON"
    )
    args = parser.parse_args(argv)
    mode: EvalMode = "live" if args.live else "offline"
    if mode == "live" and not _live_configured():
        sys.exit(
            "Live evals need GEMINI_API_KEY, SUPABASE_URL and "
            "SUPABASE_PUBLISHABLE_KEY in backend/.env."
        )
    upload = (
        mode == "live"
        and not args.no_upload
        and bool(os.environ.get("LANGSMITH_API_KEY") or settings.langsmith_api_key)
    )
    if upload:
        _export_langsmith_settings()
    # LangSmith prints its own progress to stdout, which would break --json.
    with contextlib.redirect_stdout(sys.stderr):
        scorecard = asyncio.run(run(mode, experiment=args.experiment, upload=upload))
    print(scorecard.model_dump_json(indent=2) if args.json else scorecard.render())


if __name__ == "__main__":
    main()
