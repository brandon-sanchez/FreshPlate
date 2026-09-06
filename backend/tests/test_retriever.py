"""Behavior tests for the end-to-end embedding and retrieval seam."""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any, TypedDict

import httpx
import pytest

from app.ai.rag.embeddings import EMBEDDING_DIMENSIONS, EmbeddingClient
from app.ai.rag.retriever import RecipeRetriever
from app.ai.rag.vector_store import SupabaseVectorStore


class FakeEmbeddingModels:
    async def embed_content(self, **kwargs: Any) -> Any:
        assert kwargs["contents"] == "cilantro"
        return SimpleNamespace(
            embeddings=[
                SimpleNamespace(values=[1.0, *([0.0] * (EMBEDDING_DIMENSIONS - 1))])
            ]
        )


class RecipeFixture(TypedDict):
    id: int
    title: str
    content: str
    embedding: list[float]


class FakeHttpClient:
    _recipes: tuple[RecipeFixture, ...] = (
        {
            "id": 101,
            "title": "Coriander Leaves Curry",
            "content": "Cook coriander leaves with chickpeas.",
            "embedding": [0.99, 0.1],
        },
        {
            "id": 102,
            "title": "Roasted Carrots",
            "content": "Roast carrots with cumin.",
            "embedding": [0.1, 0.99],
        },
    )

    async def post(self, url: str, **kwargs: Any) -> httpx.Response:
        assert url.endswith("/rest/v1/rpc/match_recipe_embeddings")
        assert kwargs["json"]["match_count"] == 2
        query_embedding = kwargs["json"]["query_embedding"]
        rows = []
        for recipe in self._recipes:
            similarity = sum(
                query_embedding[index] * recipe["embedding"][index]
                for index in range(2)
            )
            rows.append(
                {
                    "id": recipe["id"],
                    "title": recipe["title"],
                    "content": recipe["content"],
                    "similarity": similarity,
                }
            )

        return httpx.Response(
            200,
            json=[rows[1], rows[0]],
            request=httpx.Request("POST", url),
        )


@pytest.mark.asyncio
async def test_retriever_finds_coriander_leaves_for_a_cilantro_query() -> None:
    retriever = RecipeRetriever(
        EmbeddingClient(
            api_key="test-key",
            client=SimpleNamespace(aio=SimpleNamespace(models=FakeEmbeddingModels())),
        ),
        SupabaseVectorStore(
            url="https://project.supabase.co",
            anon_key="test-anon-key",
            http_client=FakeHttpClient(),
        ),
    )

    results = await retriever.search("cilantro", limit=2)

    assert results[0].title == "Coriander Leaves Curry"
    assert results[0].similarity > results[1].similarity
