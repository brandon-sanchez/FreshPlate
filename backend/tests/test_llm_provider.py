"""Behavior tests for the Gemini/FakeProvider public seam."""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest
from pydantic import BaseModel

from app.ai.llm.providers import (
    DEFAULT_GEMINI_MODEL,
    FakeProvider,
    GeminiProvider,
    ProviderError,
)


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


def fake_gemini_client(models: FakeGeminiModels) -> SimpleNamespace:
    return SimpleNamespace(aio=SimpleNamespace(models=models))


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
