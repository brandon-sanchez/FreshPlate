"""Gemini and deterministic fake implementations of the LLM provider seam."""

from __future__ import annotations

from collections import deque
from collections.abc import Iterable, Mapping
from typing import Any, TypeVar, cast

import google.genai as genai
from google.genai import types
from pydantic import BaseModel, ValidationError

from app.ai.llm.errors import ProviderError
from app.core.config import settings

DEFAULT_GEMINI_MODEL = "gemini-3.6-flash"

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
    ) -> ResponseModel:
        """Return the next queued response, validated as the requested model."""
        del prompt, system_instruction

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
    ) -> None:
        self._api_key = settings.gemini_api_key if api_key is None else api_key
        self._client = client

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
    ) -> ResponseModel:
        """Generate and validate one structured response from Gemini."""
        client = self._get_client()
        config_kwargs: dict[str, Any] = {
            "response_mime_type": "application/json",
            "response_json_schema": response_model.model_json_schema(),
        }
        if system_instruction is not None:
            config_kwargs["system_instruction"] = system_instruction

        try:
            response = await client.aio.models.generate_content(
                model=self.model,
                contents=prompt,
                config=types.GenerateContentConfig(**config_kwargs),
            )
        except Exception as exc:
            raise ProviderError(
                "Gemini generation failed",
                cause=exc,
                status_code=_status_code(exc),
            ) from exc

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


def _status_code(error: BaseException) -> int | None:
    """Extract a numeric upstream status without depending on SDK internals."""
    for attribute in ("status_code", "code"):
        value = getattr(error, attribute, None)
        if isinstance(value, int):
            return value
    return None
