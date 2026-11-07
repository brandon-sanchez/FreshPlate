"""Gemini and deterministic fake implementations of the LLM provider seam."""

from __future__ import annotations

import logging
import time
from collections import deque
from collections.abc import Iterable, Mapping
from typing import Any, TypeVar, cast

import google.genai as genai
from google.genai import types
from pydantic import BaseModel, ValidationError

from app.ai.llm.errors import (
    ProviderError,
    retry_after_seconds_from_error,
    status_code_from_error,
)
from app.ai.llm.protocol import ThinkingLevel
from app.ai.llm.retry import PipelineDeadline, RetryPolicy
from app.core.config import settings

logger = logging.getLogger("freshplate.llm.provider")

# Gemini Developer API pricing lists this model in the free tier. Keep the
# model pin explicit so a future change does not accidentally add paid usage.
DEFAULT_GEMINI_MODEL = "gemini-3.6-flash"

# Gemini rejects any HTTP deadline below 10 seconds with a non-retryable
# 400 INVALID_ARGUMENT ("Minimum allowed deadline is 10s"). Starting such a
# request can only fail, so the provider treats it as deadline exhaustion.
GEMINI_MIN_DEADLINE_SECONDS = 10.0

ResponseModel = TypeVar("ResponseModel", bound=BaseModel)
FakeResponse = BaseModel | Mapping[str, Any] | Exception


class FakeProvider:
    """A deterministic provider backed by a caller-supplied response queue."""

    def __init__(self, responses: Iterable[FakeResponse] = ()) -> None:
        self._responses = deque(responses)

    async def generate(
        self,
        prompt: str,
        *,
        response_model: type[ResponseModel],
        system_instruction: str | None = None,
        deadline: PipelineDeadline | None = None,
        thinking: ThinkingLevel | None = None,
    ) -> ResponseModel:
        """Return the next queued response, validated as the requested model."""
        del prompt, system_instruction, thinking

        if deadline is not None and deadline.expired:
            raise ProviderError("LLM pipeline deadline exhausted")

        if not self._responses:
            raise ProviderError("FakeProvider has no response configured")

        response = self._responses.popleft()
        if isinstance(response, ProviderError):
            raise response
        if isinstance(response, Exception):
            raise ProviderError("FakeProvider failed", cause=response) from response

        if isinstance(response, BaseModel):
            response = cast(BaseModel, response).model_dump(mode="python")

        try:
            return response_model.model_validate(response)
        except ValidationError as exc:
            raise ProviderError(
                "FakeProvider returned invalid structured output"
            ) from exc


class GeminiProvider:
    """The production Gemini provider using Google's official GenAI SDK."""

    def __init__(
        self,
        api_key: str | None = None,
        *,
        client: Any | None = None,
        retry_policy: RetryPolicy | None = None,
    ) -> None:
        self._api_key = settings.gemini_api_key if api_key is None else api_key
        self._client = client
        self._retry_policy = retry_policy or RetryPolicy()

    @property
    def model(self) -> str:
        """Return the only model this provider is allowed to call."""
        return DEFAULT_GEMINI_MODEL

    async def generate(
        self,
        prompt: str,
        *,
        response_model: type[ResponseModel],
        system_instruction: str | None = None,
        deadline: PipelineDeadline | None = None,
        thinking: ThinkingLevel | None = None,
    ) -> ResponseModel:
        """Generate and validate one structured response from Gemini."""
        client = self._get_client()
        active_deadline = deadline or PipelineDeadline.from_now()

        async def generate_once(shared_deadline: PipelineDeadline) -> ResponseModel:
            return await self._generate_once(
                client,
                prompt,
                response_model=response_model,
                system_instruction=system_instruction,
                deadline=shared_deadline,
                thinking=thinking,
            )

        return await self._retry_policy.run(
            generate_once,
            deadline=active_deadline,
        )

    async def _generate_once(
        self,
        client: Any,
        prompt: str,
        *,
        response_model: type[ResponseModel],
        system_instruction: str | None,
        deadline: PipelineDeadline,
        thinking: ThinkingLevel | None,
    ) -> ResponseModel:
        """Make one SDK request using only the remaining shared budget."""
        config_kwargs: dict[str, Any] = {
            "response_mime_type": "application/json",
            "response_json_schema": response_model.model_json_schema(),
        }
        if system_instruction is not None:
            config_kwargs["system_instruction"] = system_instruction
        if thinking is not None:
            config_kwargs["thinking_config"] = types.ThinkingConfig(
                thinking_level=types.ThinkingLevel(thinking.upper())
            )
        if deadline.remaining_seconds < GEMINI_MIN_DEADLINE_SECONDS:
            raise ProviderError("Gemini pipeline deadline exhausted")
        timeout_ms = deadline.remaining_milliseconds
        http_options = types.HttpOptions(
            timeout=timeout_ms,
            retry_options=types.HttpRetryOptions(attempts=1),
        )

        started = time.monotonic()
        try:
            response = await client.aio.models.generate_content(
                model=self.model,
                contents=prompt,
                config=types.GenerateContentConfig(
                    http_options=http_options, **config_kwargs
                ),
            )
        except Exception as exc:
            status_code = status_code_from_error(exc)
            self._log_call(
                None,
                response_model,
                thinking,
                started,
                outcome=f"error:{status_code or type(exc).__name__}",
            )
            raise ProviderError(
                "Gemini generation failed",
                cause=exc,
                status_code=status_code,
                retry_after_seconds=retry_after_seconds_from_error(exc),
            ) from exc
        self._log_call(response, response_model, thinking, started, outcome="ok")

        try:
            response_text = response.text
        except Exception as exc:
            raise ProviderError(
                "Gemini returned no usable response", cause=exc
            ) from exc
        if not isinstance(response_text, str) or not response_text.strip():
            raise ProviderError("Gemini returned no structured output")

        try:
            return response_model.model_validate_json(response_text)
        except ValidationError as exc:
            raise ProviderError("Gemini returned invalid structured output") from exc

    def _log_call(
        self,
        response: Any,
        response_model: type[BaseModel],
        thinking: ThinkingLevel | None,
        started: float,
        *,
        outcome: str,
    ) -> None:
        """Log one structured record per Gemini call for latency and spend.

        Failed calls are logged too, with zero tokens, because a timeout that
        used up the deadline is the slowest call a request can make.
        """
        usage = getattr(response, "usage_metadata", None)
        call = {
            "model": self.model,
            "thinking": thinking or "default",
            "response_model": response_model.__name__,
            "outcome": outcome,
            "prompt_tokens": _token_count(usage, "prompt_token_count"),
            "output_tokens": _token_count(usage, "candidates_token_count"),
            "thinking_tokens": _token_count(usage, "thoughts_token_count"),
            "latency_ms": round((time.monotonic() - started) * 1000),
        }
        logger.info(
            "Gemini call %s",
            " ".join(f"{key}={value}" for key, value in call.items()),
            extra={"gemini_call": call},
        )

    def _get_client(self) -> Any:
        if self._client is not None:
            return self._client
        if not self._api_key:
            raise ProviderError("Gemini API key is not configured")

        try:
            self._client = genai.Client(api_key=self._api_key)
        except Exception as exc:
            raise ProviderError(
                "Gemini client could not be created", cause=exc
            ) from exc
        return self._client


def _token_count(usage: Any, field: str) -> int:
    value = getattr(usage, field, None)
    return value if isinstance(value, int) else 0
