"""Download, embed, and resumably load the Food.com recipe corpus.

Usage:
    cd backend
    venv/bin/python -m scripts.load_recipe_corpus

The default work directory is ``backend/.local/recipe-corpus``. It contains
the Kaggle download and checkpoint state and is ignored by git. The command
requires the Kaggle CLI, GEMINI_API_KEY, SUPABASE_URL,
SUPABASE_PUBLISHABLE_KEY, and SUPABASE_SECRET_KEY in backend/.env. Legacy
SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY values remain supported during
the Supabase API key migration. The public Kaggle dataset does not normally
require a Kaggle credential; configure one separately if Kaggle prompts for it.
The loader waits through Gemini rate-limit windows and resumes the current
batch automatically.
"""

from __future__ import annotations

import argparse
import asyncio
import os
import shutil
import subprocess
import zipfile
from collections.abc import Iterable, Mapping
from pathlib import Path
from typing import Any

from app.ai.llm.retry import PipelineDeadline, RetryPolicy
from app.ai.rag.corpus import (
    DATASET_RECIPE_FILE,
    DATASET_SLUG,
    DEFAULT_CORPUS_SIZE,
    CorpusRecipe,
    parse_recipe_row,
    read_recipe_rows,
    stratified_subset,
)
from app.ai.rag.corpus_loader import (
    DEFAULT_CORPUS_BATCH_SIZE,
    DEFAULT_EMBEDDING_TIMEOUT_SECONDS,
    DEFAULT_INTER_BATCH_DELAY_SECONDS,
    DEFAULT_MAX_RATE_LIMIT_WAIT_SECONDS,
    DEFAULT_WRITE_TIMEOUT_SECONDS,
    RecipeCorpusLoader,
)
from app.ai.rag.corpus_store import SupabaseCorpusStore
from app.ai.rag.embeddings import EmbeddingClient
from app.ai.rag.retriever import RecipeRetriever
from app.ai.rag.vector_store import SupabaseVectorStore
from app.core.config import settings

DEFAULT_WORK_DIR = Path(__file__).resolve().parents[1] / ".local" / "recipe-corpus"
DEFAULT_SPOT_CHECK_QUERIES = ("cilantro", "pasta", "chicken")


def download_dataset(
    destination: Path,
    *,
    kaggle_command: str = "kaggle",
) -> Path:
    """Download only the recipe Parquet file through the Kaggle CLI."""
    destination.mkdir(parents=True, exist_ok=True)
    source_path = destination / DATASET_RECIPE_FILE
    if source_path.is_file():
        return source_path

    archive_path = destination / f"{DATASET_RECIPE_FILE}.zip"
    if archive_path.is_file():
        return _extract_recipe_archive(archive_path, destination)

    subprocess.run(
        [
            kaggle_command,
            "datasets",
            "download",
            "-d",
            DATASET_SLUG,
            "-f",
            DATASET_RECIPE_FILE,
            "-p",
            str(destination),
            "--unzip",
        ],
        check=True,
    )
    if not source_path.is_file():
        if archive_path.is_file():
            return _extract_recipe_archive(archive_path, destination)
        matches = sorted(destination.rglob(DATASET_RECIPE_FILE))
        if len(matches) != 1:
            raise RuntimeError(f"Kaggle download did not produce {DATASET_RECIPE_FILE}")
        source_path = matches[0]
    return source_path


def _extract_recipe_archive(archive_path: Path, destination: Path) -> Path:
    """Extract the expected Parquet member from Kaggle's downloaded archive."""
    try:
        with zipfile.ZipFile(archive_path) as archive:
            members = [
                member
                for member in archive.infolist()
                if not member.is_dir()
                and Path(member.filename).name == DATASET_RECIPE_FILE
            ]
            if len(members) != 1:
                raise RuntimeError(
                    f"Kaggle archive did not contain exactly one {DATASET_RECIPE_FILE}"
                )

            temporary_path = destination / f".{DATASET_RECIPE_FILE}.tmp"
            with (
                archive.open(members[0]) as source,
                temporary_path.open("wb") as target,
            ):
                shutil.copyfileobj(source, target)
            os.replace(temporary_path, destination / DATASET_RECIPE_FILE)
    except (OSError, zipfile.BadZipFile) as exc:
        raise RuntimeError(f"Could not extract {archive_path}") from exc

    return destination / DATASET_RECIPE_FILE


def select_recipes(
    rows: Iterable[Mapping[str, Any]],
    *,
    target_size: int,
) -> tuple[list[CorpusRecipe], int]:
    """Parse rows and return the deterministic selected corpus plus skip count."""
    parsed = []
    skipped = 0
    for row in rows:
        recipe = parse_recipe_row(row)
        if recipe is None:
            skipped += 1
        else:
            parsed.append(recipe)
    return stratified_subset(parsed, target_size=target_size), skipped


async def run_spot_checks(
    *,
    embedder: EmbeddingClient,
    vector_store: SupabaseVectorStore,
    queries: Iterable[str] = DEFAULT_SPOT_CHECK_QUERIES,
) -> None:
    """Run known retrieval queries after loading and print ranked titles."""
    retriever = RecipeRetriever(embedder, vector_store)
    for query in queries:
        results = await retriever.search(
            query,
            limit=3,
            deadline=PipelineDeadline.from_now(),
        )
        if not results:
            raise RuntimeError(f"Spot check returned no recipes for query {query!r}")
        print(f"spot_check={query}")
        for rank, result in enumerate(results, start=1):
            print(f"  {rank}. {result.title} ({result.similarity:.3f})")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--work-dir",
        type=Path,
        default=DEFAULT_WORK_DIR,
        help="Ignored local directory for the download and checkpoint.",
    )
    parser.add_argument(
        "--source",
        type=Path,
        help="Existing recipes.parquet path; skips Kaggle download.",
    )
    parser.add_argument(
        "--no-download",
        action="store_true",
        help="Fail instead of invoking Kaggle when the source is absent.",
    )
    parser.add_argument(
        "--kaggle-command",
        default="kaggle",
        help="Kaggle CLI executable name or path.",
    )
    parser.add_argument(
        "--target-size",
        type=int,
        default=DEFAULT_CORPUS_SIZE,
        help="Number of recipes in the deterministic subset.",
    )
    parser.add_argument(
        "--batch-size",
        type=int,
        default=DEFAULT_CORPUS_BATCH_SIZE,
        help="Recipes embedded and upserted per batch.",
    )
    parser.add_argument(
        "--inter-batch-delay-seconds",
        type=float,
        default=DEFAULT_INTER_BATCH_DELAY_SECONDS,
        help="Pause between batches to respect embedding throughput limits.",
    )
    parser.add_argument(
        "--embedding-timeout-seconds",
        type=float,
        default=DEFAULT_EMBEDDING_TIMEOUT_SECONDS,
        help="Retry/deadline budget for each embedding batch.",
    )
    parser.add_argument(
        "--write-timeout-seconds",
        type=float,
        default=DEFAULT_WRITE_TIMEOUT_SECONDS,
        help="Timeout for each Supabase upsert batch.",
    )
    parser.add_argument(
        "--max-rate-limit-wait-seconds",
        type=float,
        default=DEFAULT_MAX_RATE_LIMIT_WAIT_SECONDS,
        help="Maximum cumulative rate-limit wait for one embedding batch.",
    )
    parser.add_argument(
        "--checkpoint",
        type=Path,
        help="Checkpoint path; defaults to <work-dir>/checkpoint.json.",
    )
    parser.add_argument(
        "--skip-spot-check",
        action="store_true",
        help="Skip post-load retrieval checks.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Select and report the corpus without calling Gemini or Supabase.",
    )
    return parser


async def run(args: argparse.Namespace) -> None:
    work_dir: Path = args.work_dir
    source_path = args.source or work_dir / DATASET_RECIPE_FILE
    if not source_path.is_file():
        if args.no_download or args.source:
            raise FileNotFoundError(f"Recipe source does not exist: {source_path}")
        source_path = download_dataset(
            work_dir,
            kaggle_command=args.kaggle_command,
        )

    selected, skipped = select_recipes(
        read_recipe_rows(source_path),
        target_size=args.target_size,
    )
    print(f"source={source_path} selected={len(selected)} skipped_invalid={skipped}")
    if args.dry_run:
        return

    _require_runtime_settings()
    checkpoint_path = args.checkpoint or work_dir / "checkpoint.json"
    embedder = EmbeddingClient(
        retry_policy=RetryPolicy(retry_rate_limits=False),
    )
    loader = RecipeCorpusLoader(
        embedder,
        SupabaseCorpusStore(),
        batch_size=args.batch_size,
        inter_batch_delay_seconds=args.inter_batch_delay_seconds,
        embedding_timeout_seconds=args.embedding_timeout_seconds,
        write_timeout_seconds=args.write_timeout_seconds,
        max_rate_limit_wait_seconds=args.max_rate_limit_wait_seconds,
        progress=lambda completed, total: print(
            f"loaded={completed}/{total}", flush=True
        ),
        on_rate_limit_wait=lambda delay: print(
            f"rate_limited wait_seconds={delay:.1f}", flush=True
        ),
    )
    summary = await loader.load(selected, checkpoint_path=checkpoint_path)
    print(
        f"completed={summary.completed} resumed_from={summary.resumed_from} "
        f"processed_this_run={summary.processed_this_run}"
    )

    if not args.skip_spot_check:
        await run_spot_checks(
            embedder=EmbeddingClient(),
            vector_store=SupabaseVectorStore(),
        )


def _require_runtime_settings() -> None:
    missing = [
        name
        for name, value in (
            ("GEMINI_API_KEY", settings.gemini_api_key),
            ("SUPABASE_URL", settings.supabase_url),
            (
                "SUPABASE_PUBLISHABLE_KEY",
                settings.supabase_publishable_key or settings.supabase_anon_key,
            ),
            (
                "SUPABASE_SECRET_KEY",
                settings.supabase_secret_key or settings.supabase_service_role_key,
            ),
        )
        if not value
    ]
    if missing:
        raise SystemExit(
            "Set the required backend/.env values before loading the corpus: "
            + ", ".join(missing)
        )


def main() -> None:
    args = build_parser().parse_args()
    asyncio.run(run(args))


if __name__ == "__main__":
    main()
