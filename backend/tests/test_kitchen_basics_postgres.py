"""Kitchen basics schema, defaults and RLS tests against a disposable PostgreSQL cluster."""

# ruff: noqa: E501

from __future__ import annotations

import json
from uuid import uuid4

import pytest

from tests.pg_support import (
    DSN,
    FOODS_MIGRATIONS,
    OTHER,
    USER,
    disposable_database,
    household,
    q,
)

pytestmark = pytest.mark.skipif(not DSN, reason="Requires disposable local PostgreSQL")

DEFAULTS = ["Salt", "Black pepper", "Neutral oil", "Olive oil", "Water"]


@pytest.fixture(scope="module")
def database():
    yield from disposable_database(
        (
            *FOODS_MIGRATIONS,
            "20260804220854_recipe_feed_sessions.sql",
            "20260805190000_recipe_feed_retrieval_cursor.sql",
            "20260905063603_secure_atomic_recipe_feed_refills.sql",
            "20261114170000_add_kitchen_basics.sql",
        )
    )


def basics(db, household_id, *, user=USER):
    return db.json(
        "SELECT coalesce(json_agg(name ORDER BY created_at, name), '[]') FROM kitchen_basics "
        f"WHERE household_id = {q(household_id)}",
        role="authenticated",
        user=user,
    )


def test_a_new_household_starts_with_the_default_basics(database):
    home = household(database)

    assert sorted(basics(database, home)) == sorted(DEFAULTS)


def test_members_add_and_remove_their_own_basics(database):
    home = household(database)

    database.run(
        f"INSERT INTO kitchen_basics (household_id, name) VALUES ({q(home)}, ' Smoked  paprika ')",
        role="authenticated",
        user=USER,
    )
    database.run(
        f"DELETE FROM kitchen_basics WHERE household_id = {q(home)} AND name = 'Water'",
        role="authenticated",
        user=USER,
    )

    names = basics(database, home)
    assert "Smoked paprika" in names
    assert "Water" not in names


def test_a_basic_is_listed_once_per_household_whatever_its_case(database):
    home = household(database)

    result = database.run(
        f"INSERT INTO kitchen_basics (household_id, name) VALUES ({q(home)}, 'SALT')",
        role="authenticated",
        user=USER,
        check=False,
    )

    assert result.returncode != 0
    assert "kitchen_basics_household_id_name_key_key" in result.stderr


@pytest.mark.parametrize("name", ["", "   ", "x" * 41])
def test_a_basic_needs_a_short_visible_name(database, name):
    home = household(database)

    result = database.run(
        f"INSERT INTO kitchen_basics (household_id, name) VALUES ({q(home)}, {q(name)})",
        role="authenticated",
        user=USER,
        check=False,
    )

    assert result.returncode != 0


def test_other_households_cannot_read_or_change_the_list(database):
    home = household(database)

    assert basics(database, home, user=OTHER) == []
    insert = database.run(
        f"INSERT INTO kitchen_basics (household_id, name) VALUES ({q(home)}, 'Butter')",
        role="authenticated",
        user=OTHER,
        check=False,
    )
    database.run(
        f"DELETE FROM kitchen_basics WHERE household_id = {q(home)}",
        role="authenticated",
        user=OTHER,
    )

    assert insert.returncode != 0
    assert "row-level security" in insert.stderr
    assert sorted(basics(database, home)) == sorted(DEFAULTS)


def test_clients_cannot_rename_a_basic_or_call_the_seeding_function(database):
    home = household(database)

    rename = database.run(
        f"UPDATE kitchen_basics SET name = 'Sugar' WHERE household_id = {q(home)}",
        role="authenticated",
        user=USER,
        check=False,
    )
    seed = database.run(
        "SELECT public.seed_kitchen_basics()",
        role="authenticated",
        user=USER,
        check=False,
    )
    anon = database.run(
        "SELECT count(*) FROM kitchen_basics", role="anon", check=False
    )

    assert rename.returncode != 0
    assert seed.returncode != 0
    assert anon.returncode != 0


def test_a_feed_session_keeps_the_basics_it_was_generated_with(database):
    session_id = str(uuid4())
    session = {
        "id": session_id,
        "inventory": [],
        "preferences": {},
        "usable_items": [{"id": "spinach", "name": "Spinach"}],
        "retrieved_recipes": [],
        "exclude_titles": [],
        "retrieval_cursor": 0,
        "kitchen_basics": ["Salt", "Olive oil"],
    }
    row = database.json(
        "SELECT row_to_json(s) FROM public.create_recipe_feed_session("
        f"{q(USER)}, {q(json.dumps(session))}::jsonb, '[]'::jsonb) s",
        role="service_role",
    )

    assert row["kitchen_basics"] == ["Salt", "Olive oil"]


def test_a_household_keeps_at_most_thirty_basics(database):
    home = household(database)
    database.run(
        "INSERT INTO kitchen_basics (household_id, name) "
        f"SELECT {q(home)}, 'Spice ' || n FROM generate_series(1, 25) AS n",
        role="authenticated",
        user=USER,
    )

    full = database.run(
        f"INSERT INTO kitchen_basics (household_id, name) VALUES ({q(home)}, 'Butter')",
        role="authenticated",
        user=USER,
        check=False,
    )

    assert full.returncode != 0
    assert "KITCHEN_BASICS_FULL" in full.stderr
    assert len(basics(database, home)) == 30


def test_a_client_created_household_still_gets_its_defaults(database):
    home = str(uuid4())

    database.run(
        f"INSERT INTO households VALUES ({q(home)})", role="authenticated", user=USER
    )
    database.run(f"INSERT INTO household_members VALUES ({q(home)}, {q(USER)})")

    assert sorted(basics(database, home)) == sorted(DEFAULTS)
