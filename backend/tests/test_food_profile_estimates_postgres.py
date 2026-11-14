"""Estimated food profile facts and save_food_profile_estimate against disposable PostgreSQL."""

# ruff: noqa: E501

from __future__ import annotations

import json
from decimal import Decimal

import pytest

from app.inventory.food_facts import food_facts_from_row
from app.inventory.units import Approximate, to_stock
from tests.pg_support import (
    DSN,
    FOODS_MIGRATIONS,
    MIGRATIONS,
    OTHER,
    USER,
    add_lot,
    disposable_database,
    household,
    lit,
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
            "20261108120000_add_food_profile_estimates.sql",
        )
    )


def save_sql(
    food_id, profile_name, g_per_ml=None, unit_grams=None, by="gemini-3.6-flash"
):
    grams = None if unit_grams is None else json.dumps(unit_grams)
    return (
        "\\set VERBOSITY verbose\n"
        f"SELECT public.save_food_profile_estimate({q(food_id)}, {lit(profile_name)}, "
        f"{lit(g_per_ml)}, {lit(grams)}, {lit(by)});"
    )


def save(db, food_id, profile_name, g_per_ml=None, unit_grams=None):
    return db.run(
        save_sql(food_id, profile_name, g_per_ml, unit_grams), role="service_role"
    )


def rejected(db, sql, role="service_role", user=None):
    result = db.run(sql, role=role, user=user, check=False)
    assert result.returncode != 0
    return result.stderr


def facts_row(db, food_id):
    return db.json(f"SELECT row_to_json(f) FROM food_facts f WHERE id = {q(food_id)}")


def profile(db, key):
    return db.json(
        f"SELECT row_to_json(p) FROM food_profiles p WHERE profile_key = {q(key)}"
    )


def new_food(db, name, stock_base="g", member=USER, **kwargs):
    home = household(db, member)
    return add_lot(db, home, name, stock_base, 100, user=member, **kwargs)["food_id"]


def test_unmatched_food_gets_an_llm_profile_with_a_self_alias_and_a_pin(database):
    food = new_food(database, "Grandma's chutney")
    assert save(database, food, "Mango Chutney", 1.1, {"tbsp": 20}) == "mango chutney"
    stored = profile(database, "mango chutney")
    assert stored["source"] == "llm"
    assert stored["unit_grams"] == {} and stored["g_per_ml"] is None
    assert stored["estimated_unit_grams"] == {"tbsp": 20}
    assert stored["estimated_by"] == "gemini-3.6-flash"
    assert (
        database.run(
            "SELECT profile_key FROM food_profile_aliases WHERE alias_key = 'mango chutney'"
        )
        == "mango chutney"
    )
    assert (
        database.run(
            "SELECT count(*) FROM food_profile_aliases WHERE alias_key = 'grandma''s chutney'"
        )
        == "0"
    )
    row = facts_row(database, food)
    assert row["profile_key"] == "mango chutney"
    assert row["profile_g_per_ml"] == 1.1
    assert row["profile_estimated_at"] is not None
    assert (
        database.run(f"SELECT profile_key FROM foods WHERE id = {q(food)}")
        == "mango chutney"
    )


def test_estimate_is_stored_once_and_reused_by_another_household(database):
    first = new_food(database, "Spicy pickle relish")
    assert save(database, first, "pickle relish", 1.05, {"tbsp": 15}) == "pickle relish"
    stored = profile(database, "pickle relish")

    second = new_food(database, "Corner store relish", member=OTHER)
    assert save(database, second, "Pickle relish", 3.0, {"tbsp": 99}) == "pickle relish"
    assert profile(database, "pickle relish") == stored
    assert facts_row(database, second)["profile_unit_grams"] == {"tbsp": 15}

    named_alike = new_food(database, "Pickle Relish", member=OTHER)
    row = facts_row(database, named_alike)
    assert row["profile_key"] == "pickle relish"
    assert row["profile_estimated_at"] == stored["estimated_at"]
    assert (
        database.run(
            f"SELECT profile_key IS NULL FROM foods WHERE id = {q(named_alike)}"
        )
        == "t"
    )


def test_food_named_like_its_new_profile_resolves_by_alias_without_a_pin(database):
    food = new_food(database, "Black garlic paste")
    assert save(database, food, "black garlic paste", None, {}) == "black garlic paste"
    assert (
        database.run(f"SELECT profile_key IS NULL FROM foods WHERE id = {q(food)}")
        == "t"
    )
    assert facts_row(database, food)["profile_key"] == "black garlic paste"


def test_a_generic_name_that_is_an_alias_lands_on_its_profile(database):
    food = new_food(database, "Thai fragrant grain")
    assert save(database, food, "Jasmine Rice", None, {}) == "rice"
    assert profile(database, "jasmine rice") is None
    assert database.run(f"SELECT profile_key FROM foods WHERE id = {q(food)}") == "rice"


def test_an_unmatched_food_cannot_set_the_facts_of_an_existing_profile(database):
    garlic = new_food(database, "Garlic", "each", each_label="head")
    crafted = new_food(database, "Garlic head weighs 25 kg", member=OTHER)
    assert save(database, crafted, "garlic", None, {"head": 25000}) == "garlic"
    assert profile(database, "garlic")["estimated_at"] is None
    assert facts_row(database, garlic)["profile_estimated_at"] is None


def test_garlic_in_heads_converts_cloves_with_the_estimated_head(database):
    food = new_food(database, "Garlic", "each", each_label="head")
    assert facts_row(database, food)["profile_estimated_at"] is None
    assert save(database, food, "garlic", None, {"head": 40, "clove": 5}) == "garlic"

    row = facts_row(database, food)
    assert row["profile_unit_grams"]["clove"] == 3
    assert row["profile_unit_grams"]["head"] == 40
    facts = food_facts_from_row(row)
    assert to_stock(D(3), "cloves", facts) == Approximate(D(9) / D(40))


def test_sourced_profile_facts_win_over_estimates(database):
    food = new_food(database, "Gala apples", "each", each_label="apple")
    save(database, food, "apple", 0.9, {"each": 999, "slice": 20})
    row = facts_row(database, food)
    assert D(str(row["profile_g_per_ml"])) == D("0.5283")
    assert row["profile_unit_grams"]["each"] == 182
    assert row["profile_unit_grams"]["slice"] == 20


def test_reseeding_keeps_estimates_on_usda_profiles(database):
    food = new_food(database, "Lentils")
    save(database, food, "lentils", None, {"handful": 30})
    before = profile(database, "lentils")
    database.run((MIGRATIONS / SEED_MIGRATION).read_text())
    after = profile(database, "lentils")
    assert after == before
    assert after["estimated_unit_grams"] == {"handful": 30}


def test_renaming_a_food_clears_its_pin_but_a_case_change_keeps_it(database):
    home = household(database)
    food = add_lot(database, home, "Nonna's sauce", "ml", 500)["food_id"]
    save(database, food, "smoky romesco", 1.03, {})

    def rename(name):
        database.run(
            f"UPDATE foods SET name = {q(name)} WHERE id = {q(food)}",
            role="authenticated",
            user=USER,
        )
        return database.run(
            f"SELECT coalesce(profile_key, '-') FROM foods WHERE id = {q(food)}"
        )

    assert rename("NONNA'S SAUCE") == "smoky romesco"
    assert rename("Jasmine rice") == "-"
    assert facts_row(database, food)["profile_key"] == "rice"


def test_a_missing_food_raises_no_data_found(database):
    stderr = rejected(
        database, save_sql("00000000-0000-0000-0000-00000000dead", "rice")
    )
    assert "P0002" in stderr


@pytest.mark.parametrize(
    ("g_per_ml", "unit_grams"),
    [(None, {"head": 0}), (None, {"head": "40"}), (None, {"head": -2}), (-1, {})],
)
def test_non_positive_or_non_number_estimates_are_rejected(
    database, g_per_ml, unit_grams
):
    food = new_food(database, "Bad estimate probe")
    stderr = rejected(
        database, save_sql(food, "bad estimate probe", g_per_ml, unit_grams)
    )
    assert "23514" in stderr
    assert profile(database, "bad estimate probe") is None


def test_estimates_need_a_model_id(database):
    food = new_food(database, "Anonymous estimate probe")
    stderr = rejected(database, save_sql(food, "anonymous probe", None, {}, by=None))
    assert "food_profiles_estimate_provenance" in stderr


def test_clients_cannot_save_estimates_or_write_estimate_columns(database):
    food = new_food(database, "Client probe")
    for role in ("anon", "authenticated"):
        stderr = rejected(
            database,
            save_sql(food, "client probe", None, {"each": 5}),
            role=role,
            user=USER,
        )
        assert "permission denied for function save_food_profile_estimate" in stderr
        stderr = rejected(
            database,
            "UPDATE food_profiles SET estimated_unit_grams = '{\"clove\": 9}' WHERE profile_key = 'garlic'",
            role=role,
            user=USER,
        )
        assert "permission denied for table food_profiles" in stderr
    assert profile(database, "client probe") is None
