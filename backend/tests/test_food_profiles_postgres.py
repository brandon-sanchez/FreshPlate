"""Food profile aliases, the USDA seed and the food_facts view against disposable PostgreSQL."""

# ruff: noqa: E501

from __future__ import annotations

from decimal import Decimal

import pytest

from app.inventory.food_facts import food_facts_from_row
from app.inventory.units import Approximate, Exact, normalize_unit, to_stock
from app.inventory.usda_profiles import FoodProfile, render_seed_sql
from tests.pg_support import (
    DSN,
    FOODS_MIGRATIONS,
    MIGRATIONS,
    OTHER,
    USER,
    add_lot,
    disposable_database,
    household,
    q,
)

pytestmark = pytest.mark.skipif(not DSN, reason="Requires disposable local PostgreSQL")
D = Decimal
SEED_MIGRATION = "20261108090100_seed_food_profiles.sql"


@pytest.fixture(scope="module")
def database():
    yield from disposable_database(
        (
            *FOODS_MIGRATIONS,
            "20261108090000_add_food_profile_aliases.sql",
            SEED_MIGRATION,
        )
    )


def facts_row(db, food_id: str, user: str = USER):
    return db.json(
        f"SELECT row_to_json(f) FROM food_facts f WHERE id = {q(food_id)}",
        role="authenticated",
        user=user,
    )


def test_alias_resolves_basmati_rice_to_the_rice_profile(database):
    food = add_lot(database, household(database), "Basmati  Rice", "g", 1000)["food_id"]
    row = facts_row(database, food)
    assert row["profile_key"] == "rice"
    assert row["profile_source"] == "usda"
    assert row["profile_unit_grams"]["cup"] == 185


def test_one_cup_of_basmati_rice_from_the_view_is_approximate_grams(database):
    food = add_lot(database, household(database), "Basmati rice", "g", 1000)["food_id"]
    facts = food_facts_from_row(facts_row(database, food))
    assert to_stock(D(1), "cup", facts) == Approximate(D(185))


def test_household_units_come_through_the_view_as_exact(database):
    home = household(database)
    food = add_lot(database, home, "Garlic", "each", 2, each_label="head")["food_id"]
    database.run(
        f"INSERT INTO food_units VALUES ({q(food)}, {q(home)}, 'clove', 0.1)",
        role="authenticated",
        user=USER,
    )
    facts = food_facts_from_row(facts_row(database, food))
    assert facts.profile is not None and facts.profile.unit_grams["clove"] == D(3)
    assert to_stock(D(2), "cloves", facts) == Exact(D("0.2"))


def test_unknown_food_is_listed_as_unmatched(database):
    home = household(database)
    known = add_lot(database, home, "Onions", "g", 500)["food_id"]
    unknown = add_lot(database, home, "Grandma's chutney", "g", 200)["food_id"]
    unmatched = database.run(
        f"SELECT string_agg(id::text, ',') FROM food_facts WHERE household_id = {q(home)} AND profile_key IS NULL"
    )
    assert unmatched == unknown
    assert facts_row(database, known)["profile_key"] == "onion"
    row = facts_row(database, unknown)
    assert row["profile_unit_grams"] is None
    assert food_facts_from_row(row).profile is None


def test_ambiguous_pepper_stays_unmatched(database):
    food = add_lot(database, household(database), "Pepper", "g", 50)["food_id"]
    assert facts_row(database, food)["profile_key"] is None


def test_pinned_profile_wins_over_the_alias(database):
    food = add_lot(database, household(database), "Basmati rice", "g", 1000)["food_id"]
    database.run(
        f"UPDATE foods SET profile_key = 'short grain rice' WHERE id = {q(food)}"
    )
    assert facts_row(database, food)["profile_key"] == "short grain rice"


def test_rename_re_resolves_the_profile(database):
    home = household(database)
    food = add_lot(database, home, "Mystery grain", "g", 1000)["food_id"]
    assert facts_row(database, food)["profile_key"] is None
    database.run(
        f"UPDATE foods SET name = 'Jasmine rice' WHERE id = {q(food)}",
        role="authenticated",
        user=USER,
    )
    assert facts_row(database, food)["profile_key"] == "rice"


def test_members_see_only_their_households_food_facts(database):
    food = add_lot(database, household(database), "Basmati rice", "g", 1000)["food_id"]
    assert facts_row(database, food, user=OTHER) is None
    denied = database.run("SELECT count(*) FROM food_facts", role="anon", check=False)
    assert "permission denied" in denied.stderr


def test_clients_read_aliases_but_cannot_write_them(database):
    assert (
        database.run(
            "SELECT profile_key FROM food_profile_aliases WHERE alias_key = 'jasmine rice'",
            role="authenticated",
            user=USER,
        )
        == "rice"
    )
    denied = database.run(
        "INSERT INTO food_profile_aliases VALUES ('my rice', 'rice')",
        role="authenticated",
        user=USER,
        check=False,
    )
    assert "permission denied" in denied.stderr


def test_alias_keys_must_be_normalized_names(database):
    result = database.run(
        "INSERT INTO food_profile_aliases VALUES ('Brown  Basmati', 'rice')",
        check=False,
    )
    assert "food_profile_aliases_alias_key_check" in result.stderr


def test_seed_upsert_updates_usda_rows_and_never_overwrites_others(database):
    database.run(
        "INSERT INTO food_profiles VALUES ('house blend', 0.5, '{\"cup\": 120}', 'manual', NULL)"
    )

    def profile(key: str, cup: int) -> FoodProfile:
        return FoodProfile(key, D("0.6"), {"cup": D(cup)}, "fdc:1", (f"{key} alias",))

    database.run(
        render_seed_sql([profile("seed probe", 100), profile("house blend", 140)])
    )
    database.run(
        render_seed_sql([profile("seed probe", 150), profile("house blend", 150)])
    )
    rows = database.json(
        "SELECT json_object_agg(profile_key, json_build_array(source, unit_grams->'cup')) "
        "FROM food_profiles WHERE profile_key IN ('seed probe', 'house blend')"
    )
    assert rows == {"seed probe": ["usda", 150], "house blend": ["manual", 120]}
    assert (
        database.run(
            "SELECT profile_key FROM food_profile_aliases WHERE alias_key = 'house blend alias'"
        )
        == "house blend"
    )


def test_reseeding_leaves_aliases_of_non_usda_profiles_in_place(database):
    database.run(
        "INSERT INTO food_profiles VALUES ('house rice', NULL, '{}', 'llm', NULL);"
        "UPDATE food_profile_aliases SET profile_key = 'house rice' "
        "WHERE alias_key = 'basmati rice'"
    )
    try:
        database.run((MIGRATIONS / SEED_MIGRATION).read_text())
        assert (
            database.run(
                "SELECT profile_key FROM food_profile_aliases WHERE alias_key = 'basmati rice'"
            )
            == "house rice"
        )
    finally:
        database.run(
            "UPDATE food_profile_aliases SET profile_key = 'rice' "
            "WHERE alias_key = 'basmati rice'; DELETE FROM food_profiles WHERE profile_key = 'house rice'"
        )


def test_reseeding_moves_an_alias_between_usda_profiles(database):
    def profile(key: str, aliases: tuple[str, ...]) -> FoodProfile:
        return FoodProfile(key, None, {}, "fdc:1", aliases)

    database.run(render_seed_sql([profile("probe a", ("probe alias",))]))
    database.run(render_seed_sql([profile("probe b", ("probe alias",))]))
    assert (
        database.run(
            "SELECT profile_key FROM food_profile_aliases WHERE alias_key = 'probe alias'"
        )
        == "probe b"
    )


def test_every_seeded_whole_item_weight_is_keyed_by_the_profile_name(database):
    seeded = database.json(
        "SELECT json_object_agg(profile_key, unit_grams) FROM food_profiles WHERE source = 'usda'"
    )
    whole_items = {key: grams for key, grams in seeded.items() if "each" in grams}
    assert len(whole_items) > 50
    for key, grams in seeded.items():
        assert grams.get(normalize_unit(key)) == grams.get("each"), key


def test_seed_loads_the_whole_catalogue(database):
    counts = database.run(
        "SELECT count(*) FILTER (WHERE source = 'usda') || ',' || "
        "(SELECT count(*) FROM food_profile_aliases) FROM food_profiles"
    )
    profiles, aliases = map(int, counts.split(","))
    assert profiles >= 300
    assert aliases > profiles
