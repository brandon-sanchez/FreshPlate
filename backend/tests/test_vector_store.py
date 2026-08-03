"""Behavior tests for the Supabase pgvector search seam."""

from __future__ import annotations

from typing import Any

import httpx
import pytest

from app.ai.llm.retry import PipelineDeadline
from app.ai.rag.embeddings import EMBEDDING_DIMENSIONS
from app.ai.rag.vector_store import SupabaseVectorStore


class FakeHttpClient:
    def __init__(self, response: httpx.Response) -> None:
        self.response = response
        self.calls: list[dict[str, Any]] = []

    async def post(self, url: str, **kwargs: Any) -> httpx.Response:
        self.calls.append({"url": url, **kwargs})
        return self.response


@pytest.mark.asyncio
async def test_vector_store_returns_ranked_recipe_rows_from_similarity_rpc() -> None:
    response = httpx.Response(
        200,
        json=[
            {
                "id": 101,
                "title": "Coriander Leaves Pasta",
                "content": "Toss pasta with coriander leaves.",
                "similarity": 0.92,
            },
            {
                "id": 102,
                "title": "Roasted Carrots",
                "content": "Roast carrots with cumin.",
                "similarity": 0.71,
            },
        ],
        request=httpx.Request(
            "POST",
            "https://project.supabase.co/rest/v1/rpc/match_recipe_embeddings",
        ),
    )
    http_client = FakeHttpClient(response)
    store = SupabaseVectorStore(
        url="https://project.supabase.co",
        anon_key="test-anon-key",
        http_client=http_client,
    )

    results = await store.search(
        [1.0, *([0.0] * (EMBEDDING_DIMENSIONS - 1))],
        limit=2,
        match_threshold=0.7,
        deadline=PipelineDeadline(5.0),
    )

    assert [recipe.title for recipe in results] == [
        "Coriander Leaves Pasta",
        "Roasted Carrots",
    ]
    assert [recipe.similarity for recipe in results] == pytest.approx([0.92, 0.71])

    call = http_client.calls[0]
    assert call["url"] == (
        "https://project.supabase.co/rest/v1/rpc/match_recipe_embeddings"
    )
    assert call["headers"] == {
        "apikey": "test-anon-key",
        "Authorization": "Bearer test-anon-key",
    }
    assert call["json"] == {
        "query_embedding": [1.0, *([0.0] * (EMBEDDING_DIMENSIONS - 1))],
        "match_threshold": 0.7,
        "match_count": 2,
    }
    assert call["timeout"] == pytest.approx(5.0, rel=1e-4)
