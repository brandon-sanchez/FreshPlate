"""Resumable, batch-oriented loading of recipe embeddings into Supabase."""

from __future__ import annotations

import asyncio
import json
import math
import os
from collections.abc import Awaitable, Callable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol

from app.ai.llm.errors import ProviderError
from app.ai.llm.retry import PipelineDeadline
from app.ai.rag.corpus import (
    MAX_CORPUS_BATCH_SIZE,
    CorpusRecipe,
    source_fingerprint,
)
from app.ai.rag.embeddings import DEFAULT_EMBEDDING_DOCUMENT_TASK

DEFAULT_CORPUS_BATCH_SIZE = 100
DEFAULT_INTER_BATCH_DELAY_SECONDS = 1.0
DEFAULT_EMBEDDING_TIMEOUT_SECONDS = 120.0
DEFAULT_WRITE_TIMEOUT_SECONDS = 60.0
DEFAULT_RATE_LIMIT_FALLBACK_DELAY_SECONDS = 60.0
DEFAULT_RATE_LIMIT_MAX_DELAY_SECONDS = 300.0
DEFAULT_RATE_LIMIT_SAFETY_SECONDS = 1.0
DEFAULT_MAX_RATE_LIMIT_WAIT_SECONDS = 3600.0
CHECKPOINT_VERSION = 1


class CorpusLoadError(RuntimeError):
    """Raised when a corpus load cannot safely continue or resume."""


class BatchEmbedder(Protocol):
    async def embed_many(
        self,
        texts: Sequence[str],
        *,
        task_type: str,
        deadline: PipelineDeadline,
    ) -> list[list[float]]: ...


class CorpusWriter(Protocol):
    async def upsert(
        self,
        rows: Sequence[Mapping[str, Any]],
        *,
        timeout_seconds: float,
    ) -> None: ...


@dataclass(frozen=True, slots=True)
class CorpusCheckpoint:
    """The last fully upserted batch in a deterministic corpus selection."""

    fingerprint: str
    total: int
    next_index: int

    def as_dict(self) -> dict[str, Any]:
        return {
            "version": CHECKPOINT_VERSION,
            "fingerprint": self.fingerprint,
            "total": self.total,
            "next_index": self.next_index,
        }

    def write(self, path: Path) -> None:
        """Atomically persist progress after a successful database upsert."""
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary_path = path.with_name(f".{path.name}.tmp")
        temporary_path.write_text(
            json.dumps(self.as_dict(), indent=2) + "\n",
            encoding="utf-8",
        )
        os.replace(temporary_path, path)

    @classmethod
    def read(cls, path: Path) -> "CorpusCheckpoint":
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, TypeError, ValueError) as exc:
            raise CorpusLoadError(f"Could not read checkpoint {path}") from exc
        if not isinstance(payload, dict):
            raise CorpusLoadError(f"Checkpoint {path} must contain a JSON object")
        if payload.get("version") != CHECKPOINT_VERSION:
            raise CorpusLoadError(f"Checkpoint {path} has an unsupported version")

        fingerprint = payload.get("fingerprint")
        total = payload.get("total")
        next_index = payload.get("next_index")
        if (
            not isinstance(fingerprint, str)
            or not fingerprint
            or not isinstance(total, int)
            or isinstance(total, bool)
            or total < 1
            or not isinstance(next_index, int)
            or isinstance(next_index, bool)
            or not 0 <= next_index <= total
        ):
            raise CorpusLoadError(f"Checkpoint {path} contains invalid progress")
        return cls(
            fingerprint=fingerprint,
            total=total,
            next_index=next_index,
        )


@dataclass(frozen=True, slots=True)
class CorpusLoadSummary:
    """Observable result of one load invocation."""

    total_recipes: int
    resumed_from: int
    processed_this_run: int

    @property
    def completed(self) -> bool:
        return self.resumed_from + self.processed_this_run == self.total_recipes


ProgressCallback = Callable[[int, int], None]
RateLimitWaitCallback = Callable[[float], None]
Sleep = Callable[[float], Awaitable[None]]


class RecipeCorpusLoader:
    """Embed and upsert a deterministic recipe selection with crash-safe resume."""

    def __init__(
        self,
        embedder: BatchEmbedder,
        writer: CorpusWriter,
        *,
        batch_size: int = DEFAULT_CORPUS_BATCH_SIZE,
        inter_batch_delay_seconds: float = DEFAULT_INTER_BATCH_DELAY_SECONDS,
        embedding_timeout_seconds: float = DEFAULT_EMBEDDING_TIMEOUT_SECONDS,
        write_timeout_seconds: float = DEFAULT_WRITE_TIMEOUT_SECONDS,
        sleep: Sleep | None = None,
        progress: ProgressCallback | None = None,
        rate_limit_safety_seconds: float = DEFAULT_RATE_LIMIT_SAFETY_SECONDS,
        max_rate_limit_wait_seconds: float | None = DEFAULT_MAX_RATE_LIMIT_WAIT_SECONDS,
        on_rate_limit_wait: RateLimitWaitCallback | None = None,
    ) -> None:
        if not isinstance(batch_size, int) or isinstance(batch_size, bool):
            raise ValueError("Corpus batch size must be an integer")
        if batch_size < 1:
            raise ValueError("Corpus batch size must be greater than zero")
        if batch_size > MAX_CORPUS_BATCH_SIZE:
            raise ValueError(f"Corpus batch size cannot exceed {MAX_CORPUS_BATCH_SIZE}")
        for name, value in (
            ("inter-batch delay", inter_batch_delay_seconds),
            ("embedding timeout", embedding_timeout_seconds),
            ("write timeout", write_timeout_seconds),
        ):
            if not math.isfinite(value) or value < 0:
                raise ValueError(f"Corpus {name} must be finite and non-negative")
        if embedding_timeout_seconds == 0 or write_timeout_seconds == 0:
            raise ValueError("Corpus network timeouts must be greater than zero")
        if (
            not math.isfinite(rate_limit_safety_seconds)
            or rate_limit_safety_seconds < 0
        ):
            raise ValueError("Rate-limit safety delay must be finite and non-negative")
        if max_rate_limit_wait_seconds is not None and (
            not math.isfinite(max_rate_limit_wait_seconds)
            or max_rate_limit_wait_seconds < 0
        ):
            raise ValueError("Maximum rate-limit wait must be finite and non-negative")

        self._embedder = embedder
        self._writer = writer
        self._batch_size = batch_size
        self._inter_batch_delay_seconds = inter_batch_delay_seconds
        self._embedding_timeout_seconds = embedding_timeout_seconds
        self._write_timeout_seconds = write_timeout_seconds
        self._sleep = sleep or asyncio.sleep
        self._progress = progress
        self._rate_limit_safety_seconds = rate_limit_safety_seconds
        self._max_rate_limit_wait_seconds = max_rate_limit_wait_seconds
        self._on_rate_limit_wait = on_rate_limit_wait

    async def load(
        self,
        recipes: Sequence[CorpusRecipe],
        *,
        checkpoint_path: Path,
    ) -> CorpusLoadSummary:
        """Load recipes, checkpointing only after each complete upsert."""
        selected = tuple(recipes)
        if not selected:
            raise CorpusLoadError("Cannot load an empty recipe corpus")
        ids = [recipe.id for recipe in selected]
        if len(set(ids)) != len(ids):
            raise CorpusLoadError("Recipe corpus contains duplicate ids")

        fingerprint = source_fingerprint(selected)
        total = len(selected)
        checkpoint = self._load_or_start_checkpoint(
            checkpoint_path,
            fingerprint=fingerprint,
            total=total,
        )
        start_index = checkpoint.next_index
        if start_index == total:
            return CorpusLoadSummary(total, start_index, 0)

        for batch_start in range(start_index, total, self._batch_size):
            batch_end = min(batch_start + self._batch_size, total)
            batch = selected[batch_start:batch_end]
            embeddings = await self._embed_batch(batch)
            if len(embeddings) != len(batch):
                raise CorpusLoadError(
                    "Embedding provider returned a different number of vectors"
                )

            rows = [
                recipe.embedding_row(embedding)
                for recipe, embedding in zip(batch, embeddings, strict=True)
            ]
            await self._writer.upsert(
                rows,
                timeout_seconds=self._write_timeout_seconds,
            )
            CorpusCheckpoint(
                fingerprint=fingerprint,
                total=total,
                next_index=batch_end,
            ).write(checkpoint_path)
            if self._progress is not None:
                self._progress(batch_end, total)

            if batch_end < total and self._inter_batch_delay_seconds:
                await self._sleep(self._inter_batch_delay_seconds)

        return CorpusLoadSummary(
            total_recipes=total,
            resumed_from=start_index,
            processed_this_run=total - start_index,
        )

    async def _embed_batch(self, batch: Sequence[CorpusRecipe]) -> list[list[float]]:
        """Embed one batch, waiting through provider rate-limit windows."""
        rate_limit_attempt = 0
        total_rate_limit_wait = 0.0
        while True:
            try:
                return await self._embedder.embed_many(
                    [recipe.content for recipe in batch],
                    task_type=DEFAULT_EMBEDDING_DOCUMENT_TASK,
                    deadline=PipelineDeadline(self._embedding_timeout_seconds),
                )
            except ProviderError as exc:
                if exc.status_code != 429:
                    raise

                delay = self._rate_limit_delay(exc, rate_limit_attempt)
                total_rate_limit_wait += delay
                if (
                    self._max_rate_limit_wait_seconds is not None
                    and total_rate_limit_wait > self._max_rate_limit_wait_seconds
                ):
                    raise CorpusLoadError(
                        "Maximum cumulative rate-limit wait exceeded for one "
                        "embedding batch"
                    ) from exc

                if self._on_rate_limit_wait is not None:
                    self._on_rate_limit_wait(delay)
                await self._sleep(delay)
                rate_limit_attempt += 1

    def _rate_limit_delay(
        self,
        error: ProviderError,
        attempt: int,
    ) -> float:
        if error.retry_after_seconds is not None:
            provider_delay = error.retry_after_seconds
        else:
            fallback_delay = DEFAULT_RATE_LIMIT_FALLBACK_DELAY_SECONDS * (
                2 ** min(attempt, 3)
            )
            provider_delay = min(
                fallback_delay,
                DEFAULT_RATE_LIMIT_MAX_DELAY_SECONDS,
            )
        return provider_delay + self._rate_limit_safety_seconds

    @staticmethod
    def _load_or_start_checkpoint(
        path: Path,
        *,
        fingerprint: str,
        total: int,
    ) -> CorpusCheckpoint:
        if not path.exists():
            return CorpusCheckpoint(fingerprint=fingerprint, total=total, next_index=0)

        checkpoint = CorpusCheckpoint.read(path)
        if checkpoint.fingerprint != fingerprint or checkpoint.total != total:
            raise CorpusLoadError(
                "Existing corpus checkpoint does not match the selected source; "
                "remove it to intentionally restart"
            )
        return checkpoint
