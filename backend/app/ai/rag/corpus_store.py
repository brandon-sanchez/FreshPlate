"""Authenticated PostgREST upserts for the non-user recipe corpus."""

from __future__ import annotations

import math
from collections.abc import Mapping, Sequence
from typing import Any

import httpx
from pydantic import BaseModel, Field, field_validator

from app.ai.rag.corpus import MAX_CORPUS_BATCH_SIZE
from app.ai.rag.embeddings import EMBEDDING_DIMENSIONS
from app.core.config import settings, validate_supabase_url

CORPUS_TABLE = "recipe_embeddings"
MAX_UPSERT_BATCH_SIZE = MAX_CORPUS_BATCH_SIZE
DEFAULT_WRITE_TIMEOUT_SECONDS = 60.0


class CorpusStoreError(RuntimeError):
    """Raised when the local corpus loader cannot write to Supabase."""


class RecipeEmbeddingRow(BaseModel):
    """Validated row accepted by the recipe corpus table."""

    id: int = Field(gt=0)
    title: str = Field(min_length=1)
    content: str = Field(min_length=1)
    embedding: list[float] = Field(
        min_length=EMBEDDING_DIMENSIONS,
        max_length=EMBEDDING_DIMENSIONS,
    )

    @field_validator("title", "content")
    @classmethod
    def text_must_not_be_blank(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("Recipe text must not be blank")
        return value

    @field_validator("embedding")
    @classmethod
    def embedding_must_be_finite(cls, value: list[float]) -> list[float]:
        if not all(math.isfinite(item) for item in value):
            raise ValueError("Recipe embedding must contain finite numbers")
        return value


class SupabaseCorpusStore:
    """Write corpus rows through a trusted-key-only local ingestion path."""

    def __init__(
        self,
        url: str | None = None,
        service_role_key: str | None = None,
        *,
        secret_key: str | None = None,
        http_client: Any | None = None,
    ) -> None:
        if secret_key is not None and service_role_key is not None:
            raise ValueError("Provide either secret_key or service_role_key, not both")
        self._url = validate_supabase_url(settings.supabase_url if url is None else url)
        if secret_key is not None:
            self._api_key = secret_key
            self._uses_legacy_jwt = False
        elif service_role_key is not None:
            self._api_key = service_role_key
            self._uses_legacy_jwt = True
        elif settings.supabase_secret_key.get_secret_value():
            self._api_key = settings.supabase_secret_key.get_secret_value()
            self._uses_legacy_jwt = False
        else:
            self._api_key = settings.supabase_service_role_key.get_secret_value()
            self._uses_legacy_jwt = True
        self._http_client = http_client

    async def upsert(
        self,
        rows: Sequence[Mapping[str, Any]],
        *,
        timeout_seconds: float = DEFAULT_WRITE_TIMEOUT_SECONDS,
    ) -> None:
        """Merge a bounded batch by stable recipe id without logging credentials."""
        if not rows:
            raise ValueError("Recipe corpus upsert requires at least one row")
        if len(rows) > MAX_UPSERT_BATCH_SIZE:
            raise ValueError(
                f"Recipe corpus upsert cannot exceed {MAX_UPSERT_BATCH_SIZE} rows"
            )
        if not math.isfinite(timeout_seconds) or timeout_seconds <= 0:
            raise ValueError("Corpus write timeout must be greater than zero")
        if not self._url:
            raise CorpusStoreError("Supabase URL is not configured")
        if not self._api_key:
            raise CorpusStoreError(
                "SUPABASE_SECRET_KEY or legacy SUPABASE_SERVICE_ROLE_KEY is "
                "required for corpus loading"
            )

        payload = [RecipeEmbeddingRow.model_validate(row).model_dump() for row in rows]
        url = f"{self._url.rstrip('/')}/rest/v1/{CORPUS_TABLE}?on_conflict=id"
        headers = {
            "apikey": self._api_key,
            "Content-Type": "application/json",
            "Prefer": "resolution=merge-duplicates,return=minimal",
        }
        if self._uses_legacy_jwt:
            headers["Authorization"] = f"Bearer {self._api_key}"

        try:
            if self._http_client is None:
                async with httpx.AsyncClient() as client:
                    response = await client.post(
                        url,
                        headers=headers,
                        json=payload,
                        timeout=timeout_seconds,
                    )
            else:
                response = await self._http_client.post(
                    url,
                    headers=headers,
                    json=payload,
                    timeout=timeout_seconds,
                )
            response.raise_for_status()
        except httpx.TimeoutException as exc:
            raise CorpusStoreError("Recipe corpus upsert timed out") from exc
        except httpx.HTTPStatusError as exc:
            raise CorpusStoreError(
                f"Recipe corpus upsert failed with HTTP {exc.response.status_code}"
            ) from exc
        except httpx.HTTPError as exc:
            raise CorpusStoreError("Recipe corpus upsert failed") from exc
