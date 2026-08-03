"""Behavior tests for the authenticated corpus upsert seam."""

from __future__ import annotations

from typing import Any

import httpx
import pytest

from app.ai.rag.corpus_store import SupabaseCorpusStore
from app.ai.rag.embeddings import EMBEDDING_DIMENSIONS


class FakeHttpClient:
    def __init__(self, response: httpx.Response) -> None:
        self.response = response
        self.calls: list[dict[str, Any]] = []

    async def post(self, url: str, **kwargs: Any) -> httpx.Response:
        self.calls.append({"url": url, **kwargs})
        return self.response


def embedding() -> list[float]:
    return [1.0, *([0.0] * (EMBEDDING_DIMENSIONS - 1))]


@pytest.mark.asyncio
async def test_corpus_store_upserts_idempotently_with_service_role_headers() -> None:
    response = httpx.Response(
        204,
        request=httpx.Request(
            "POST",
            "https://project.supabase.co/rest/v1/recipe_embeddings?on_conflict=id",
        ),
    )
    http_client = FakeHttpClient(response)
    store = SupabaseCorpusStore(
        url="https://project.supabase.co",
        service_role_key="test-service-role-key",
        http_client=http_client,
    )

    await store.upsert(
        [
            {
                "id": 42,
                "title": "Coriander Pasta",
                "content": "Ingredients: coriander leaves",
                "embedding": embedding(),
            }
        ],
        timeout_seconds=12.0,
    )

    call = http_client.calls[0]
    assert call["url"].endswith("/recipe_embeddings?on_conflict=id")
    assert call["headers"] == {
        "apikey": "test-service-role-key",
        "Authorization": "Bearer test-service-role-key",
        "Content-Type": "application/json",
        "Prefer": "resolution=merge-duplicates,return=minimal",
    }
    assert call["json"][0]["id"] == 42
    assert call["timeout"] == pytest.approx(12.0)


@pytest.mark.asyncio
async def test_corpus_store_uses_secret_key_without_jwt_bearer_header(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    response = httpx.Response(
        204,
        request=httpx.Request(
            "POST",
            "https://project.supabase.co/rest/v1/recipe_embeddings?on_conflict=id",
        ),
    )
    http_client = FakeHttpClient(response)
    monkeypatch.setattr(
        "app.ai.rag.corpus_store.settings.supabase_secret_key",
        "sb_secret_test-key",
    )
    monkeypatch.setattr(
        "app.ai.rag.corpus_store.settings.supabase_service_role_key", ""
    )
    store = SupabaseCorpusStore(
        url="https://project.supabase.co",
        http_client=http_client,
    )

    await store.upsert(
        [
            {
                "id": 42,
                "title": "Coriander Pasta",
                "content": "Ingredients: coriander leaves",
                "embedding": embedding(),
            }
        ]
    )

    assert http_client.calls[0]["headers"] == {
        "apikey": "sb_secret_test-key",
        "Content-Type": "application/json",
        "Prefer": "resolution=merge-duplicates,return=minimal",
    }


@pytest.mark.asyncio
async def test_corpus_store_rejects_invalid_rows_before_network_call() -> None:
    http_client = FakeHttpClient(httpx.Response(204))
    store = SupabaseCorpusStore(
        url="https://project.supabase.co",
        service_role_key="test-service-role-key",
        http_client=http_client,
    )

    with pytest.raises(ValueError, match="768"):
        await store.upsert(
            [
                {
                    "id": 42,
                    "title": "Recipe",
                    "content": "Content",
                    "embedding": [1.0],
                }
            ]
        )

    assert http_client.calls == []
