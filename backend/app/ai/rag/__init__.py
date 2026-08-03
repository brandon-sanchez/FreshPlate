"""Retrieval-augmented generation infrastructure."""

from app.ai.rag.corpus import (
    DATASET_RECIPE_FILE,
    DATASET_SLUG,
    DEFAULT_CORPUS_SIZE,
    MAX_CORPUS_BATCH_SIZE,
    CorpusRecipe,
    parse_recipe_row,
    source_fingerprint,
    stratified_subset,
)
from app.ai.rag.corpus_loader import (
    CorpusCheckpoint,
    CorpusLoadError,
    CorpusLoadSummary,
    RecipeCorpusLoader,
)
from app.ai.rag.corpus_store import CorpusStoreError, SupabaseCorpusStore
from app.ai.rag.embeddings import (
    DEFAULT_EMBEDDING_DOCUMENT_TASK,
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
    "DEFAULT_EMBEDDING_DOCUMENT_TASK",
    "EMBEDDING_DIMENSIONS",
    "DATASET_RECIPE_FILE",
    "DATASET_SLUG",
    "DEFAULT_CORPUS_SIZE",
    "MAX_CORPUS_BATCH_SIZE",
    "DEFAULT_MATCH_LIMIT",
    "DEFAULT_MATCH_THRESHOLD",
    "MAX_MATCH_LIMIT",
    "EmbeddingClient",
    "CorpusCheckpoint",
    "CorpusLoadError",
    "CorpusLoadSummary",
    "CorpusRecipe",
    "CorpusStoreError",
    "RecipeRetriever",
    "RecipeCorpusLoader",
    "RetrievedRecipe",
    "SupabaseCorpusStore",
    "SupabaseVectorStore",
    "VectorStoreError",
    "parse_recipe_row",
    "source_fingerprint",
    "stratified_subset",
]
