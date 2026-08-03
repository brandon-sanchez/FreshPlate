"""Behavior tests for resumable corpus loading."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from app.ai.llm.errors import ProviderError
from app.ai.llm.retry import PipelineDeadline
from app.ai.rag.corpus import CorpusRecipe
from app.ai.rag.corpus_loader import CorpusLoadError, RecipeCorpusLoader


def recipe(recipe_id: int) -> CorpusRecipe:
    return CorpusRecipe(
        id=recipe_id,
        title=f"Recipe {recipe_id}",
        category="Dinner",
        content=f"Title: Recipe {recipe_id}",
    )


class FakeEmbedder:
    def __init__(self, *, fail_on_call: int | None = None) -> None:
        self.calls: list[dict[str, Any]] = []
        self.fail_on_call = fail_on_call

    async def embed_many(
        self,
        texts: list[str],
        *,
        task_type: str,
        deadline: PipelineDeadline,
    ) -> list[list[float]]:
        self.calls.append(
            {"texts": texts, "task_type": task_type, "deadline": deadline}
        )
        if self.fail_on_call == len(self.calls):
            raise RuntimeError("embedding failed")
        return [[float(index)] for index in range(len(texts))]


class FakeWriter:
    def __init__(self, *, fail_on_call: int | None = None) -> None:
        self.calls: list[dict[str, Any]] = []
        self.fail_on_call = fail_on_call

    async def upsert(
        self,
        rows: list[dict[str, Any]],
        *,
        timeout_seconds: float,
    ) -> None:
        self.calls.append({"rows": rows, "timeout_seconds": timeout_seconds})
        if self.fail_on_call == len(self.calls):
            raise RuntimeError("upsert failed")


class RateLimitedEmbedder:
    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []

    async def embed_many(
        self,
        texts: list[str],
        *,
        task_type: str,
        deadline: PipelineDeadline,
    ) -> list[list[float]]:
        self.calls.append(
            {"texts": texts, "task_type": task_type, "deadline": deadline}
        )
        if len(self.calls) == 1:
            raise ProviderError(
                "rate limited",
                status_code=429,
                retry_after_seconds=3.0,
            )
        return [[float(index)] for index in range(len(texts))]


class AlwaysRateLimitedEmbedder:
    async def embed_many(
        self,
        texts: list[str],
        *,
        task_type: str,
        deadline: PipelineDeadline,
    ) -> list[list[float]]:
        del texts, task_type, deadline
        raise ProviderError(
            "rate limited",
            status_code=429,
            retry_after_seconds=2.0,
        )


@pytest.mark.asyncio
async def test_loader_embeds_then_upserts_then_advances_checkpoint(
    tmp_path: Path,
) -> None:
    embedder = FakeEmbedder()
    writer = FakeWriter()
    sleeps: list[float] = []
    loader = RecipeCorpusLoader(
        embedder,
        writer,
        batch_size=2,
        inter_batch_delay_seconds=1.25,
        sleep=lambda delay: _record_sleep(sleeps, delay),
    )
    checkpoint = tmp_path / "checkpoint.json"

    summary = await loader.load(
        [recipe(1), recipe(2), recipe(3)],
        checkpoint_path=checkpoint,
    )

    assert summary.total_recipes == 3
    assert summary.resumed_from == 0
    assert summary.processed_this_run == 3
    assert summary.completed
    assert [len(call["texts"]) for call in embedder.calls] == [2, 1]
    assert all(call["task_type"] == "RETRIEVAL_DOCUMENT" for call in embedder.calls)
    assert [len(call["rows"]) for call in writer.calls] == [2, 1]
    assert sleeps == [1.25]
    assert json.loads(checkpoint.read_text(encoding="utf-8"))["next_index"] == 3


@pytest.mark.asyncio
async def test_loader_waits_for_rate_limit_and_retries_the_same_batch(
    tmp_path: Path,
) -> None:
    embedder = RateLimitedEmbedder()
    writer = FakeWriter()
    sleeps: list[float] = []
    notifications: list[float] = []
    loader = RecipeCorpusLoader(
        embedder,
        writer,
        batch_size=2,
        inter_batch_delay_seconds=0.0,
        rate_limit_safety_seconds=0.0,
        max_rate_limit_wait_seconds=10.0,
        sleep=lambda delay: _record_sleep(sleeps, delay),
        on_rate_limit_wait=notifications.append,
    )
    checkpoint = tmp_path / "checkpoint.json"

    summary = await loader.load(
        [recipe(1), recipe(2)],
        checkpoint_path=checkpoint,
    )

    assert summary.completed
    assert len(embedder.calls) == 2
    assert len(writer.calls) == 1
    assert sleeps == [3.0]
    assert notifications == [3.0]
    assert json.loads(checkpoint.read_text(encoding="utf-8"))["next_index"] == 2


@pytest.mark.asyncio
async def test_loader_stops_after_the_configured_rate_limit_wait(
    tmp_path: Path,
) -> None:
    sleeps: list[float] = []
    loader = RecipeCorpusLoader(
        AlwaysRateLimitedEmbedder(),
        FakeWriter(),
        rate_limit_safety_seconds=0.0,
        max_rate_limit_wait_seconds=3.0,
        sleep=lambda delay: _record_sleep(sleeps, delay),
    )

    with pytest.raises(
        CorpusLoadError,
        match="Maximum cumulative rate-limit wait exceeded",
    ):
        await loader.load([recipe(1)], checkpoint_path=tmp_path / "checkpoint.json")

    assert sleeps == [2.0]


@pytest.mark.asyncio
async def test_loader_retries_the_unfinished_batch_after_a_failed_upsert(
    tmp_path: Path,
) -> None:
    first_writer = FakeWriter(fail_on_call=2)
    embedder = FakeEmbedder()
    checkpoint = tmp_path / "checkpoint.json"
    loader = RecipeCorpusLoader(embedder, first_writer, batch_size=2)

    with pytest.raises(RuntimeError, match="upsert failed"):
        await loader.load(
            [recipe(1), recipe(2), recipe(3), recipe(4)],
            checkpoint_path=checkpoint,
        )

    assert json.loads(checkpoint.read_text(encoding="utf-8"))["next_index"] == 2

    second_writer = FakeWriter()
    resumed = RecipeCorpusLoader(FakeEmbedder(), second_writer, batch_size=2)
    summary = await resumed.load(
        [recipe(1), recipe(2), recipe(3), recipe(4)],
        checkpoint_path=checkpoint,
    )

    assert summary.resumed_from == 2
    assert summary.processed_this_run == 2
    assert summary.completed
    assert [row["id"] for row in second_writer.calls[0]["rows"]] == [3, 4]


@pytest.mark.asyncio
async def test_loader_reprocesses_a_batch_when_checkpoint_save_fails(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    embedder = FakeEmbedder()
    writer = FakeWriter()
    loader = RecipeCorpusLoader(embedder, writer, batch_size=2)
    checkpoint = tmp_path / "checkpoint.json"

    original_replace = __import__("os").replace
    calls = 0

    def fail_once(source: str, destination: str) -> None:
        nonlocal calls
        calls += 1
        if calls == 1:
            raise OSError("checkpoint write failed")
        original_replace(source, destination)

    monkeypatch.setattr("app.ai.rag.corpus_loader.os.replace", fail_once)

    with pytest.raises(OSError, match="checkpoint write failed"):
        await loader.load([recipe(1), recipe(2)], checkpoint_path=checkpoint)

    assert not checkpoint.exists()


@pytest.mark.asyncio
async def test_loader_rejects_a_checkpoint_for_a_different_source(
    tmp_path: Path,
) -> None:
    checkpoint = tmp_path / "checkpoint.json"
    checkpoint.write_text(
        json.dumps(
            {
                "version": 1,
                "fingerprint": "different",
                "total": 1,
                "next_index": 0,
            }
        ),
        encoding="utf-8",
    )

    with pytest.raises(CorpusLoadError, match="does not match"):
        await RecipeCorpusLoader(FakeEmbedder(), FakeWriter()).load(
            [recipe(1)],
            checkpoint_path=checkpoint,
        )


async def _record_sleep(sleeps: list[float], delay: float) -> None:
    sleeps.append(delay)
