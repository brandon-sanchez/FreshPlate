"""Contract checks for the recipe pgvector migration."""

from __future__ import annotations

import re
from pathlib import Path

MIGRATION_PATH = (
    Path(__file__).parents[2]
    / "supabase"
    / "migrations"
    / "20260803044523_recipe_embeddings.sql"
)


def test_recipe_embeddings_migration_defines_the_public_search_contract() -> None:
    sql = re.sub(r"\s+", " ", MIGRATION_PATH.read_text(encoding="utf-8").lower())

    assert "create extension if not exists vector with schema extensions" in sql
    assert "create table public.recipe_embeddings" in sql
    assert "embedding extensions.vector(768) not null" in sql
    assert "using hnsw (embedding extensions.vector_cosine_ops)" in sql
    assert "recipes.embedding <=> query_embedding <= 1 - match_threshold" in sql
    assert "alter table public.recipe_embeddings enable row level security" in sql
    assert "for select to anon, authenticated using (true)" in sql
    assert "create or replace function public.match_recipe_embeddings" in sql
    assert "security invoker" in sql
    assert "grant execute on function public.match_recipe_embeddings" in sql


def test_recipe_embedding_loader_migration_limits_writes_to_service_role() -> None:
    migration_path = (
        MIGRATION_PATH.parent / "20260803193045_recipe_embedding_loader_permissions.sql"
    )
    sql = re.sub(r"\s+", " ", migration_path.read_text(encoding="utf-8").lower())

    assert (
        "grant select, insert, update on public.recipe_embeddings to service_role"
        in sql
    )
