"""Retrieval-augmented generation infrastructure."""

from app.ai.rag.embeddings import (
    DEFAULT_EMBEDDING_MODEL,
    EMBEDDING_DIMENSIONS,
    EmbeddingClient,
)
from app.ai.rag.retriever import RecipeRetriever
from app.ai.rag.vector_store import (
    DEFAULT_MATCH_LIMIT,
    DEFAULT_MATCH_THRESHOLD,
    MAX_MATCH_LIMIT,
    RetrievedRecipe,
    SupabaseVectorStore,
    VectorStoreError,
)

__all__ = [
    "DEFAULT_EMBEDDING_MODEL",
    "EMBEDDING_DIMENSIONS",
    "DEFAULT_MATCH_LIMIT",
    "DEFAULT_MATCH_THRESHOLD",
    "MAX_MATCH_LIMIT",
    "EmbeddingClient",
    "RecipeRetriever",
    "RetrievedRecipe",
    "SupabaseVectorStore",
    "VectorStoreError",
]
