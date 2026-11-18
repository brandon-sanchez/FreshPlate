"""Run the recipe evals and print a scorecard.

Usage:
    cd backend
    venv/bin/python -m scripts.run_evals            # offline, free
    venv/bin/python -m scripts.run_evals --live     # Gemini, billed

Offline mode answers every model call with fixtures, so it needs no keys
and checks the harness rather than recipe quality. Live mode runs the real
pipeline on Gemini and the production vector store, and the judge on
Gemini. The exit status is 0 whatever the scores are: evals inform, they
don't gate.
"""

from __future__ import annotations

import argparse
import asyncio
import sys
from collections.abc import Sequence

from app.ai.eval.cases import load_cases
from app.ai.eval.offline import OfflineModel, OfflineRetriever
from app.ai.eval.runner import EvalMode, EvalSetup, evaluate_cases
from app.ai.eval.scorecard import Scorecard
from app.ai.eval.usage import recorded_gemini_calls, summarize_calls
from app.ai.llm.providers import GeminiProvider
from app.ai.rag.embeddings import EmbeddingClient
from app.ai.rag.retriever import RecipeRetriever
from app.ai.rag.vector_store import SupabaseVectorStore
from app.core.config import settings

# Each live case makes up to five generation calls at once, then its meal
# reviews and judge calls, so two cases at a time keep about ten Gemini
# calls in flight.
_CASE_CONCURRENCY = 2


async def run(mode: EvalMode) -> Scorecard:
    """Run every case in ``mode`` and return the scorecard.

    Raises:
        EvalCaseError: When the dataset file is invalid.
    """
    cases = load_cases()
    setup = _setup(mode)
    with recorded_gemini_calls() as calls:
        results = await evaluate_cases(cases, setup, concurrency=_CASE_CONCURRENCY)
    return Scorecard.from_results(results, mode=mode, usage=summarize_calls(calls))


def _setup(mode: EvalMode) -> EvalSetup:
    if mode == "offline":
        return EvalSetup(model_for=OfflineModel, retriever=OfflineRetriever())
    gemini = GeminiProvider()
    return EvalSetup(
        model_for=lambda case: gemini,
        retriever=RecipeRetriever(EmbeddingClient(), SupabaseVectorStore()),
    )


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
        "--json", action="store_true", help="print the scorecard as JSON"
    )
    args = parser.parse_args(argv)
    mode: EvalMode = "live" if args.live else "offline"
    if mode == "live" and not _live_configured():
        sys.exit(
            "Live evals need GEMINI_API_KEY, SUPABASE_URL and "
            "SUPABASE_PUBLISHABLE_KEY in backend/.env."
        )
    scorecard = asyncio.run(run(mode))
    print(scorecard.model_dump_json(indent=2) if args.json else scorecard.render())


if __name__ == "__main__":
    main()
