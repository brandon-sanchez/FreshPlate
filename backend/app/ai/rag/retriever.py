"""Query embedding and ranked recipe retrieval."""

from __future__ import annotations

from app.ai.llm.retry import PipelineDeadline
from app.ai.rag.embeddings import EmbeddingClient
from app.ai.rag.vector_store import (
    RetrievedRecipe,
    SupabaseVectorStore,
    validate_search_options,
)


class RecipeRetriever:
    """Find recipes by embedding a query and searching the vector store."""

    def __init__(
        self,
        embedder: EmbeddingClient,
        vector_store: SupabaseVectorStore,
    ) -> None:
        self._embedder = embedder
        self._vector_store = vector_store

    async def search(
        self,
        query: str,
        *,
        limit: int = 5,
        match_threshold: float = 0.0,
        deadline: PipelineDeadline | None = None,
    ) -> list[RetrievedRecipe]:
        """Return the highest-similarity recipes for a non-empty query."""
        if not isinstance(query, str) or not query.strip():
            raise ValueError("Recipe search query must not be empty")
        validate_search_options(limit, match_threshold)

        active_deadline = deadline or PipelineDeadline.from_now()
        query_embedding = await self._embedder.embed(
            query,
            deadline=active_deadline,
        )
        results = await self._vector_store.search(
            query_embedding,
            limit=limit,
            match_threshold=match_threshold,
            deadline=active_deadline,
        )
        return sorted(results, key=lambda recipe: recipe.similarity, reverse=True)
