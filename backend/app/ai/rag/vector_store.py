"""Supabase pgvector storage and similarity-search contract."""

from __future__ import annotations

import math
from collections.abc import Sequence
from typing import Any

import httpx
from pydantic import BaseModel, Field, ValidationError

from app.ai.llm.errors import ProviderError, status_code_from_error
from app.ai.llm.retry import PipelineDeadline
from app.ai.rag.embeddings import EMBEDDING_DIMENSIONS
from app.core.config import settings, validate_supabase_url

DEFAULT_MATCH_LIMIT = 5
MAX_MATCH_LIMIT = 200
DEFAULT_MATCH_THRESHOLD = 0.0


class RetrievedRecipe(BaseModel):
    """One recipe row returned by the similarity-search RPC."""

    id: int
    title: str
    content: str
    similarity: float = Field(ge=-1.0, le=1.0)


class VectorStoreError(ProviderError):
    """A safe AI-unavailable error raised when vector search cannot complete."""


class SupabaseVectorStore:
    """Call the public, read-only recipe similarity RPC through PostgREST."""

    def __init__(
        self,
        url: str | None = None,
        anon_key: str | None = None,
        *,
        publishable_key: str | None = None,
        http_client: Any | None = None,
    ) -> None:
        if publishable_key is not None and anon_key is not None:
            raise ValueError("Provide either publishable_key or anon_key, not both")
        self._url = validate_supabase_url(settings.supabase_url if url is None else url)
        if publishable_key is not None:
            self._api_key = publishable_key
            self._uses_legacy_jwt = False
        elif anon_key is not None:
            self._api_key = anon_key
            self._uses_legacy_jwt = True
        elif settings.supabase_publishable_key:
            self._api_key = settings.supabase_publishable_key
            self._uses_legacy_jwt = False
        else:
            self._api_key = settings.supabase_anon_key
            self._uses_legacy_jwt = True
        self._http_client = http_client

    async def search(
        self,
        query_embedding: Sequence[float],
        *,
        limit: int = DEFAULT_MATCH_LIMIT,
        match_threshold: float = DEFAULT_MATCH_THRESHOLD,
        deadline: PipelineDeadline | None = None,
    ) -> list[RetrievedRecipe]:
        """Return recipes ranked by descending cosine similarity."""
        vector = _validated_embedding(query_embedding)
        validate_search_options(limit, match_threshold)

        if not self._url:
            raise VectorStoreError("Supabase URL is not configured")
        if not self._api_key:
            raise VectorStoreError(
                "Supabase publishable key or legacy anon key is not configured"
            )

        active_deadline = deadline or PipelineDeadline.from_now()
        timeout = active_deadline.remaining_seconds
        if timeout <= 0:
            raise VectorStoreError("Vector search deadline exhausted")

        url = f"{self._url.rstrip('/')}/rest/v1/rpc/match_recipe_embeddings"
        headers = {
            "apikey": self._api_key,
        }
        if self._uses_legacy_jwt:
            headers["Authorization"] = f"Bearer {self._api_key}"
        payload = {
            "query_embedding": vector,
            "match_threshold": match_threshold,
            "match_count": limit,
        }

        try:
            if self._http_client is None:
                async with httpx.AsyncClient() as client:
                    response = await client.post(
                        url,
                        headers=headers,
                        json=payload,
                        timeout=timeout,
                    )
            else:
                response = await self._http_client.post(
                    url,
                    headers=headers,
                    json=payload,
                    timeout=timeout,
                )
        except httpx.TimeoutException as exc:
            raise VectorStoreError("Vector search timed out", cause=exc) from exc
        except httpx.HTTPError as exc:
            raise VectorStoreError("Vector search failed", cause=exc) from exc

        if active_deadline.expired:
            raise VectorStoreError("Vector search deadline exhausted")

        try:
            response.raise_for_status()
        except httpx.HTTPStatusError as exc:
            raise VectorStoreError(
                "Vector search failed",
                cause=exc,
                status_code=status_code_from_error(exc),
            ) from exc

        try:
            rows = response.json()
        except (TypeError, ValueError) as exc:
            raise VectorStoreError("Vector search returned invalid JSON") from exc
        if not isinstance(rows, list):
            raise VectorStoreError("Vector search returned an invalid payload")

        try:
            return [RetrievedRecipe.model_validate(row) for row in rows]
        except (TypeError, ValidationError) as exc:
            raise VectorStoreError(
                "Vector search returned invalid recipe data"
            ) from exc


def _validated_embedding(query_embedding: Sequence[float]) -> list[float]:
    if len(query_embedding) != EMBEDDING_DIMENSIONS:
        raise ValueError(f"Query embedding must have {EMBEDDING_DIMENSIONS} dimensions")

    try:
        vector = [float(value) for value in query_embedding]
    except (TypeError, ValueError) as exc:
        raise ValueError("Query embedding must contain only numbers") from exc
    if not all(math.isfinite(value) for value in vector):
        raise ValueError("Query embedding must contain only finite numbers")
    return vector


def validate_search_options(limit: int, match_threshold: float) -> None:
    if not isinstance(limit, int) or isinstance(limit, bool):
        raise ValueError("Search limit must be an integer")
    if not 1 <= limit <= MAX_MATCH_LIMIT:
        raise ValueError(f"Search limit must be between 1 and {MAX_MATCH_LIMIT}")
    if not math.isfinite(match_threshold) or not -1.0 <= match_threshold <= 1.0:
        raise ValueError("Match threshold must be between -1 and 1")
