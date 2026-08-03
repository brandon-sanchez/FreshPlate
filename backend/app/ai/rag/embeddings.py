"""Gemini embedding client with shared retry and deadline handling."""

from __future__ import annotations

import math
from typing import Any

import google.genai as genai
from google.genai import types

from app.ai.llm.errors import ProviderError, status_code_from_error
from app.ai.llm.retry import PipelineDeadline, RetryPolicy
from app.core.config import settings

DEFAULT_EMBEDDING_MODEL = "gemini-embedding-001"
EMBEDDING_DIMENSIONS = 768
DEFAULT_EMBEDDING_TASK = "RETRIEVAL_QUERY"


class EmbeddingClient:
    """Create normalized Gemini embeddings for retrieval queries and documents."""

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

    async def embed(
        self,
        text: str,
        *,
        task_type: str = DEFAULT_EMBEDDING_TASK,
        title: str | None = None,
        deadline: PipelineDeadline | None = None,
    ) -> list[float]:
        """Return one normalized embedding under the caller's shared deadline."""
        if not isinstance(text, str) or not text.strip():
            raise ValueError("Embedding text must not be empty")
        if not task_type.strip():
            raise ValueError("Embedding task type must not be empty")

        client = self._get_client()
        active_deadline = deadline or PipelineDeadline.from_now()

        async def embed_once(shared_deadline: PipelineDeadline) -> list[float]:
            return await self._embed_once(
                client,
                text,
                task_type=task_type,
                title=title,
                deadline=shared_deadline,
            )

        return await self._retry_policy.run(
            embed_once,
            deadline=active_deadline,
        )

    async def _embed_once(
        self,
        client: Any,
        text: str,
        *,
        task_type: str,
        title: str | None,
        deadline: PipelineDeadline,
    ) -> list[float]:
        """Make one bounded SDK request and normalize its returned vector."""
        timeout_ms = deadline.remaining_milliseconds
        if timeout_ms <= 0:
            raise ProviderError("LLM pipeline deadline exhausted")

        http_options = types.HttpOptions(
            timeout=timeout_ms,
            retry_options=types.HttpRetryOptions(attempts=1),
        )
        config_kwargs: dict[str, Any] = {
            "output_dimensionality": EMBEDDING_DIMENSIONS,
            "task_type": task_type,
            "http_options": http_options,
        }
        if title is not None:
            config_kwargs["title"] = title

        try:
            response = await client.aio.models.embed_content(
                model=DEFAULT_EMBEDDING_MODEL,
                contents=text,
                config=types.EmbedContentConfig(**config_kwargs),
            )
        except Exception as exc:
            raise ProviderError(
                "Gemini embedding failed",
                cause=exc,
                status_code=status_code_from_error(exc),
            ) from exc

        embeddings = getattr(response, "embeddings", None)
        if not isinstance(embeddings, list) or len(embeddings) != 1:
            raise ProviderError("Gemini returned no usable embedding")

        values = getattr(embeddings[0], "values", None)
        if not isinstance(values, list) or len(values) != EMBEDDING_DIMENSIONS:
            raise ProviderError(
                f"Gemini returned an embedding with the wrong dimension; "
                f"expected {EMBEDDING_DIMENSIONS}"
            )

        try:
            vector = [float(value) for value in values]
        except (TypeError, ValueError) as exc:
            raise ProviderError("Gemini returned an invalid embedding") from exc

        if not all(math.isfinite(value) for value in vector):
            raise ProviderError("Gemini returned an invalid embedding")

        norm = math.sqrt(sum(value * value for value in vector))
        if norm <= 0:
            raise ProviderError("Gemini returned a zero embedding")
        return [value / norm for value in vector]

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
