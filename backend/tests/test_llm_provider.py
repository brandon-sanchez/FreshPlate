"""Behavior tests for the Gemini/FakeProvider public seam."""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any, Protocol

import pytest
from pydantic import BaseModel

from app.ai.llm.providers import (
    DEFAULT_GEMINI_MODEL,
    FakeProvider,
    GeminiProvider,
    ProviderError,
)
from app.ai.llm.retry import PipelineDeadline, RetryPolicy


class Greeting(BaseModel):
    answer: str
    confidence: float


@pytest.mark.asyncio
async def test_fake_provider_returns_validated_structured_output() -> None:
    provider = FakeProvider(
        responses=[{"answer": "Use the tomatoes first", "confidence": 0.95}]
    )

    result = await provider.generate(
        "What should I use first?",
        response_model=Greeting,
    )

    assert result == Greeting(answer="Use the tomatoes first", confidence=0.95)


@pytest.mark.asyncio
async def test_fake_provider_without_a_response_surfaces_ai_unavailable() -> None:
    provider = FakeProvider()

    with pytest.raises(ProviderError) as error:
        await provider.generate("Give me an answer", response_model=Greeting)

    assert error.value.code == "AI_UNAVAILABLE"


class FakeGeminiModels:
    def __init__(
        self, response: Any | None = None, error: Exception | None = None
    ) -> None:
        self.response = response
        self.error = error
        self.calls: list[dict[str, Any]] = []

    async def generate_content(self, **kwargs: Any) -> Any:
        self.calls.append(kwargs)
        if self.error is not None:
            raise self.error
        return self.response


class GeminiModels(Protocol):
    """The small async model surface shared by the Gemini test doubles."""

    async def generate_content(self, **kwargs: Any) -> Any:
        """Return one fake Gemini response or raise an upstream error."""
        ...


def fake_gemini_client(models: GeminiModels) -> SimpleNamespace:
    return SimpleNamespace(aio=SimpleNamespace(models=models))


class UpstreamError(RuntimeError):
    def __init__(self, status_code: int) -> None:
        super().__init__(f"upstream status {status_code}")
        self.status_code = status_code


class SequenceFakeGeminiModels:
    def __init__(self, outcomes: list[Any], *, clock: Any | None = None) -> None:
        self.outcomes = outcomes
        self.clock = clock
        self.calls: list[dict[str, Any]] = []

    async def generate_content(self, **kwargs: Any) -> Any:
        self.calls.append(kwargs)
        if self.clock is not None:
            self.clock.value += 0.5
        outcome = self.outcomes.pop(0)
        if isinstance(outcome, Exception):
            raise outcome
        return outcome


@pytest.mark.asyncio
async def test_gemini_provider_requests_json_schema_and_validates_response() -> None:
    models = FakeGeminiModels(
        response=SimpleNamespace(
            text='{"answer":"Use the tomatoes first","confidence":0.9}'
        )
    )
    provider = GeminiProvider(
        api_key="test-key",
        client=fake_gemini_client(models),
    )

    result = await provider.generate(
        "What should I use first?",
        response_model=Greeting,
        system_instruction="Be concise.",
    )

    assert result == Greeting(answer="Use the tomatoes first", confidence=0.9)
    assert len(models.calls) == 1
    call = models.calls[0]
    assert call["model"] == DEFAULT_GEMINI_MODEL
    assert call["contents"] == "What should I use first?"
    assert call["config"].response_mime_type == "application/json"
    assert call["config"].response_json_schema == Greeting.model_json_schema()
    assert call["config"].system_instruction == "Be concise."
    assert provider.model == DEFAULT_GEMINI_MODEL
    with pytest.raises(AttributeError):
        provider.model = "another-model"  # type: ignore[misc]


@pytest.mark.asyncio
async def test_gemini_provider_normalizes_upstream_failure() -> None:
    models = FakeGeminiModels(error=RuntimeError("upstream unavailable"))
    provider = GeminiProvider(
        api_key="test-key",
        client=fake_gemini_client(models),
    )

    with pytest.raises(ProviderError) as error:
        await provider.generate("Give me an answer", response_model=Greeting)

    assert error.value.code == "AI_UNAVAILABLE"
    assert isinstance(error.value.__cause__, RuntimeError)


@pytest.mark.asyncio
async def test_gemini_provider_retries_transient_failures_once_per_sdk_call() -> None:
    models = SequenceFakeGeminiModels(
        [
            UpstreamError(429),
            UpstreamError(503),
            SimpleNamespace(
                text='{"answer":"Use the tomatoes first","confidence":0.9}'
            ),
        ]
    )
    sleeps: list[float] = []

    async def sleep(delay: float) -> None:
        sleeps.append(delay)

    provider = GeminiProvider(
        api_key="test-key",
        client=fake_gemini_client(models),
        retry_policy=RetryPolicy(
            max_attempts=3,
            sleep=sleep,
            jitter_seconds=0.0,
        ),
    )

    result = await provider.generate("Give me an answer", response_model=Greeting)

    assert result == Greeting(answer="Use the tomatoes first", confidence=0.9)
    assert len(models.calls) == 3
    assert sleeps == [1.0, 2.0]
    assert all(
        call["config"].http_options.retry_options.attempts == 1 for call in models.calls
    )


@pytest.mark.asyncio
async def test_gemini_provider_passes_shared_remaining_budget_to_each_attempt() -> None:
    class Clock:
        value = 100.0

        def __call__(self) -> float:
            return self.value

    clock = Clock()
    models = SequenceFakeGeminiModels(
        [
            UpstreamError(503),
            SimpleNamespace(
                text='{"answer":"Use the tomatoes first","confidence":0.9}'
            ),
        ],
        clock=clock,
    )
    provider = GeminiProvider(
        api_key="test-key",
        client=fake_gemini_client(models),
        retry_policy=RetryPolicy(
            max_attempts=2,
            backoff_seconds=(0.0,),
            sleep=lambda delay: _completed_sleep(delay),
            jitter_seconds=0.0,
        ),
    )

    await provider.generate(
        "Give me an answer",
        response_model=Greeting,
        deadline=PipelineDeadline(30.0, clock=clock),
    )

    timeouts = [call["config"].http_options.timeout for call in models.calls]
    assert timeouts == [30000, 29500]


@pytest.mark.asyncio
async def test_gemini_provider_never_starts_an_attempt_below_the_10s_floor() -> None:
    """Gemini rejects HTTP deadlines under 10s with a non-retryable 400.

    The provider must treat that budget as exhausted instead of sending a
    request that can only fail (wayfinder ticket #42 fix).
    """
    models = FakeGeminiModels(
        response=SimpleNamespace(
            text='{"answer":"Use the tomatoes first","confidence":0.9}'
        )
    )
    provider = GeminiProvider(api_key="test-key", client=fake_gemini_client(models))

    with pytest.raises(ProviderError) as error:
        await provider.generate(
            "Give me an answer",
            response_model=Greeting,
            deadline=PipelineDeadline(9.0),
        )

    assert error.value.code == "AI_UNAVAILABLE"
    assert models.calls == []


async def _completed_sleep(delay: float) -> None:
    del delay


@pytest.mark.asyncio
async def test_gemini_provider_rejects_invalid_structured_output() -> None:
    models = FakeGeminiModels(
        response=SimpleNamespace(text='{"answer":"missing confidence"}')
    )
    provider = GeminiProvider(
        api_key="test-key",
        client=fake_gemini_client(models),
    )

    with pytest.raises(ProviderError) as error:
        await provider.generate("Give me an answer", response_model=Greeting)

    assert error.value.code == "AI_UNAVAILABLE"


@pytest.mark.asyncio
async def test_gemini_provider_rejects_missing_api_key() -> None:
    provider = GeminiProvider(api_key="")

    with pytest.raises(ProviderError) as error:
        await provider.generate("Give me an answer", response_model=Greeting)

    assert error.value.code == "AI_UNAVAILABLE"
