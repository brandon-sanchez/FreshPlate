"""Public protocol for structured language-model generation."""

from __future__ import annotations

from typing import Literal, Protocol, TypeVar

from pydantic import BaseModel

from app.ai.llm.retry import PipelineDeadline

ResponseModel = TypeVar("ResponseModel", bound=BaseModel)

# How much hidden reasoning the model may do before answering. None keeps the
# model's own default, which for the pinned Gemini Flash model is slow and
# varies run to run.
ThinkingLevel = Literal["minimal", "low", "medium", "high"]


class LLMProvider(Protocol):
    """Generate a validated structured response through an LLM provider."""

    async def generate(
        self,
        prompt: str,
        *,
        response_model: type[ResponseModel],
        system_instruction: str | None = None,
        deadline: PipelineDeadline | None = None,
        thinking: ThinkingLevel | None = None,
    ) -> ResponseModel:
        """Return a response matching ``response_model`` or raise ProviderError."""
        ...
