"""Behavior tests for the Gemini embedding client."""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest

from app.ai.llm.retry import PipelineDeadline, RetryPolicy
from app.ai.rag.embeddings import (
    DEFAULT_EMBEDDING_MODEL,
    EMBEDDING_DIMENSIONS,
    EmbeddingClient,
)


class FakeEmbeddingModels:
    def __init__(self, response: Any) -> None:
        self.response = response
        self.calls: list[dict[str, Any]] = []

    async def embed_content(self, **kwargs: Any) -> Any:
        self.calls.append(kwargs)
        return self.response


class SequenceFakeEmbeddingModels(FakeEmbeddingModels):
    def __init__(self, outcomes: list[Any], *, clock: Any | None = None) -> None:
        super().__init__(None)
        self.outcomes = outcomes
        self.clock = clock

    async def embed_content(self, **kwargs: Any) -> Any:
        self.calls.append(kwargs)
        if self.clock is not None:
            self.clock.value += 0.5
        outcome = self.outcomes.pop(0)
        if isinstance(outcome, Exception):
            raise outcome
        return outcome


def fake_gemini_client(models: FakeEmbeddingModels) -> SimpleNamespace:
    return SimpleNamespace(aio=SimpleNamespace(models=models))


def embedding_response(values: list[float]) -> SimpleNamespace:
    return SimpleNamespace(
        embeddings=[SimpleNamespace(values=values)],
    )


class UpstreamError(RuntimeError):
    def __init__(self, status_code: int) -> None:
        super().__init__(f"upstream status {status_code}")
        self.status_code = status_code


@pytest.mark.asyncio
async def test_embedding_client_normalizes_a_768_dimension_query_embedding() -> None:
    values = [3.0, 4.0, *([0.0] * (EMBEDDING_DIMENSIONS - 2))]
    models = FakeEmbeddingModels(embedding_response(values))
    client = EmbeddingClient(
        api_key="test-key",
        client=fake_gemini_client(models),
    )

    embedding = await client.embed(
        "cilantro",
        deadline=PipelineDeadline(5.0),
    )

    assert len(embedding) == EMBEDDING_DIMENSIONS
    assert embedding[:2] == pytest.approx([0.6, 0.8])
    assert sum(value * value for value in embedding) == pytest.approx(1.0)

    call = models.calls[0]
    assert call["model"] == DEFAULT_EMBEDDING_MODEL
    assert call["contents"] == "cilantro"
    assert call["config"].output_dimensionality == EMBEDDING_DIMENSIONS
    assert call["config"].task_type == "RETRIEVAL_QUERY"
    assert call["config"].http_options.timeout == 5000
    assert call["config"].http_options.retry_options.attempts == 1


@pytest.mark.asyncio
async def test_embedding_client_retries_with_the_same_deadline() -> None:
    class Clock:
        value = 100.0

        def __call__(self) -> float:
            return self.value

    clock = Clock()
    values = [1.0, *([0.0] * (EMBEDDING_DIMENSIONS - 1))]
    models = SequenceFakeEmbeddingModels(
        [UpstreamError(503), embedding_response(values)],
        clock=clock,
    )

    async def sleep(delay: float) -> None:
        del delay

    client = EmbeddingClient(
        api_key="test-key",
        client=fake_gemini_client(models),
        retry_policy=RetryPolicy(
            max_attempts=2,
            backoff_seconds=(0.0,),
            jitter_seconds=0.0,
            sleep=sleep,
        ),
    )

    await client.embed("coriander leaves", deadline=PipelineDeadline(5.0, clock=clock))

    assert len(models.calls) == 2
    assert [call["config"].http_options.timeout for call in models.calls] == [
        5000,
        4500,
    ]
    assert all(
        call["config"].http_options.retry_options.attempts == 1
        for call in models.calls
    )
