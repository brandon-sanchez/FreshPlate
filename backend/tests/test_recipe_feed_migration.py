"""Contract checks for the server-owned recipe feed migration."""

from __future__ import annotations

import re
from pathlib import Path

MIGRATION_PATH = (
    Path(__file__).parents[2]
    / "supabase"
    / "migrations"
    / "20260804220854_recipe_feed_sessions.sql"
)


def test_recipe_feed_migration_scopes_data_to_authenticated_rows() -> None:
    sql = re.sub(r"\s+", " ", MIGRATION_PATH.read_text(encoding="utf-8").lower())

    assert "create table public.recipe_feed_sessions" in sql
    assert "create table public.recipe_feed_items" in sql
    assert "expires_at timestamptz not null" in sql
    assert "unique (session_id, position)" in sql
    assert "alter table public.recipe_feed_sessions enable row level security" in sql
    assert "alter table public.recipe_feed_items enable row level security" in sql
    assert "(select auth.uid()) = user_id" in sql
    assert (
        "grant select, insert, update on public.recipe_feed_sessions "
        "to authenticated"
    ) in sql
    assert (
        "grant select, insert, update on public.recipe_feed_items "
        "to authenticated"
    ) in sql
