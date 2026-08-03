"""Public protocol for structured language-model generation."""

from __future__ import annotations

from typing import Protocol, TypeVar

from pydantic import BaseModel

from app.ai.llm.retry import PipelineDeadline

ResponseModel = TypeVar("ResponseModel", bound=BaseModel)


class LLMProvider(Protocol):
    """Generate a validated structured response through an LLM provider."""

    async def generate(
        self,
        prompt: str,
        *,
        response_model: type[ResponseModel],
        system_instruction: str | None = None,
        deadline: PipelineDeadline | None = None,
    ) -> ResponseModel:
        """Return a response matching ``response_model`` or raise ProviderError."""
        ...
