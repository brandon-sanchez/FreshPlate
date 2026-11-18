"""Recently used up contract tests (recently_used_up, restore_used_up_lot) against a disposable PostgreSQL cluster."""

# ruff: noqa: E501

from __future__ import annotations

import pytest

from tests.pg_support import (
    DB,
    DSN,
    FOODS_MIGRATIONS,
    OTHER,
    USER,
    add_lot,
    disposable_database,
    household,
    q,
)

pytestmark = pytest.mark.skipif(not DSN, reason="Requires disposable local PostgreSQL")

AS_MEMBER = {"role": "authenticated", "user": USER}


@pytest.fixture(scope="module")
def database():
    yield from disposable_database(
        FOODS_MIGRATIONS
        + (
            "20261108140000_add_lot_outcomes.sql",
            "20261113120000_add_cook_recipe_v2.sql",
            "20261117180000_add_used_up_restore.sql",
        )
    )


def cook_all_of(db: DB, home: str, food_id: str, amount: float) -> None:
    db.run(f"SELECT public.draw_food({q(home)}, {q(food_id)}, {amount});")


def used_up(db: DB, home: str, **who) -> list[dict]:
    rows = db.json(
        "SELECT coalesce(json_agg(r ORDER BY r.name), '[]') FROM ("
        "SELECT lot_id, food_id, name, stock_base, each_label, whole_units_only"
        f" FROM recently_used_up WHERE household_id = {q(home)}) r",
        **(who or AS_MEMBER),
    )
    return rows


def restore(db: DB, home: str, lot_id: str, amount, *, check=True, **who):
    sql = f"SELECT public.restore_used_up_lot({q(home)}, {q(lot_id)}, {amount});"
    return db.run(sql, check=check, **(who or AS_MEMBER))


def available(db: DB, food_id: str):
    return db.json(f"SELECT available FROM food_stock WHERE id = {q(food_id)}")


def lot(db: DB, lot_id: str):
    return db.json(
        "SELECT row_to_json(l) FROM (SELECT quantity, initial_quantity, is_estimate, depleted_at,"
        f" depleted_reason FROM lots WHERE id = {q(lot_id)}) l"
    )


def cooked_away(
    db: DB, home: str, name="Eggs", stock_base="each", quantity=6, **kwargs
) -> dict:
    if stock_base == "each":
        kwargs.setdefault("each_label", "egg")
    added = add_lot(db, home, name, stock_base, quantity, **kwargs)
    cook_all_of(db, home, added["food_id"], quantity)
    return added


def test_a_food_a_cook_emptied_is_listed_and_restores_with_the_amount_entered(database):
    home = household(database)
    eggs = cooked_away(database, home, whole_units_only=True)

    assert used_up(database, home) == [
        {
            "lot_id": eggs["lot_id"],
            "food_id": eggs["food_id"],
            "name": "Eggs",
            "stock_base": "each",
            "each_label": "egg",
            "whole_units_only": True,
        }
    ]

    restore(database, home, eggs["lot_id"], 2)

    assert available(database, eggs["food_id"]) == 2
    assert used_up(database, home) == []
    restored = lot(database, eggs["lot_id"])
    assert (
        restored["quantity"],
        restored["depleted_reason"],
        restored["is_estimate"],
    ) == (2, None, False)


def test_a_swiped_used_up_food_restores_with_the_amount_entered_not_the_old_one(
    database,
):
    home = household(database)
    milk = add_lot(database, home, "Milk", "ml", 1000)
    database.run(
        f"SELECT public.deplete_lots({q(home)}, ARRAY[{q(milk['lot_id'])}]::uuid[], 'used');",
        **AS_MEMBER,
    )

    restore(database, home, milk["lot_id"], 250)

    assert available(database, milk["food_id"]) == 250


def test_restoring_more_than_the_full_size_raises_the_full_size(database):
    home = household(database)
    rice = cooked_away(database, home, "Rice", "g", 500)

    restore(database, home, rice["lot_id"], 800)

    assert lot(database, rice["lot_id"])["initial_quantity"] == 800


def test_a_food_with_stock_left_is_not_listed(database):
    home = household(database)
    first = add_lot(database, home, "Butter", "g", 100, expiration_date="2099-01-01")
    add_lot(database, home, "Butter", "g", 250, "freezer")
    cook_all_of(database, home, first["food_id"], 100)

    assert used_up(database, home) == []


def test_only_the_food_s_latest_used_up_batch_is_listed(database):
    home = household(database)
    first = add_lot(database, home, "Flour", "g", 200, expiration_date="2099-01-01")
    second = add_lot(database, home, "Flour", "g", 300, "pantry")
    database.run(
        f"UPDATE lots SET opened_at = now() - interval '1 day' WHERE id = {q(first['lot_id'])};"
    )
    cook_all_of(database, home, first["food_id"], 200)
    database.run(
        f"UPDATE lots SET depleted_at = now() - interval '1 hour' WHERE id = {q(first['lot_id'])};"
    )
    cook_all_of(database, home, first["food_id"], 300)

    assert [row["lot_id"] for row in used_up(database, home)] == [second["lot_id"]]


def test_tossed_and_old_batches_are_not_listed_or_restorable(database):
    home = household(database)
    tossed = add_lot(database, home, "Spinach", "g", 150)
    database.run(
        f"SELECT public.deplete_lots({q(home)}, ARRAY[{q(tossed['lot_id'])}]::uuid[], 'tossed');",
        **AS_MEMBER,
    )
    old = cooked_away(database, home, "Cream", "ml", 200)
    database.run(
        f"UPDATE lots SET depleted_at = now() - interval '15 days' WHERE id = {q(old['lot_id'])};"
    )

    assert used_up(database, home) == []
    for added in (tossed, old):
        result = restore(database, home, added["lot_id"], 1, check=False)
        assert "LOT_NOT_RESTORABLE" in result.stderr
        assert available(database, added["food_id"]) == 0


def test_a_live_batch_is_not_restorable(database):
    home = household(database)
    added = add_lot(database, home, "Lemons", "each", 3, each_label="lemon")

    result = restore(database, home, added["lot_id"], 5, check=False)

    assert "LOT_NOT_RESTORABLE" in result.stderr
    assert available(database, added["food_id"]) == 3


def test_a_restored_batch_cannot_be_restored_twice(database):
    home = household(database)
    eggs = cooked_away(database, home, "Duck eggs", "each", 2)
    restore(database, home, eggs["lot_id"], 1)

    result = restore(database, home, eggs["lot_id"], 1, check=False)

    assert "LOT_NOT_RESTORABLE" in result.stderr
    assert available(database, eggs["food_id"]) == 1


@pytest.mark.parametrize("amount", ["0", "-1", "'NaN'", "'Infinity'", "NULL"])
def test_amounts_that_are_not_finite_and_positive_are_refused(database, amount):
    home = household(database)
    eggs = cooked_away(database, home)

    result = database.run(
        "\\set VERBOSITY verbose\n"
        f"SELECT public.restore_used_up_lot({q(home)}, {q(eggs['lot_id'])}, {amount});",
        check=False,
        **AS_MEMBER,
    )

    assert "ERROR:  22023" in result.stderr
    assert lot(database, eggs["lot_id"])["depleted_reason"] == "used"


def test_a_fractional_amount_of_a_whole_units_food_is_refused(database):
    home = household(database)
    cans = cooked_away(
        database,
        home,
        "Tomato cans",
        "each",
        2,
        each_label="can",
        whole_units_only=True,
    )

    result = restore(database, home, cans["lot_id"], 1.5, check=False)

    assert result.returncode != 0
    assert lot(database, cans["lot_id"])["depleted_reason"] == "used"


@pytest.mark.parametrize(
    "who",
    [
        {"role": "anon", "user": None},
        {"role": "authenticated", "user": None},
        {"role": "authenticated", "user": OTHER},
    ],
    ids=["anon", "signed-out", "other-household"],
)
def test_outsiders_cannot_see_or_restore_a_household_s_used_up_food(database, who):
    home = household(database)
    household(database, OTHER)
    eggs = cooked_away(database, home)

    if who["role"] == "authenticated":
        assert used_up(database, home, **who) == []
    result = restore(database, home, eggs["lot_id"], 3, check=False, **who)

    assert result.returncode != 0
    assert available(database, eggs["food_id"]) == 0


def test_a_member_cannot_restore_another_household_s_batch_through_their_own(database):
    home = household(database)
    other_home = household(database, OTHER)
    eggs = cooked_away(database, home)

    result = restore(
        database,
        other_home,
        eggs["lot_id"],
        3,
        check=False,
        role="authenticated",
        user=OTHER,
    )

    assert "LOT_NOT_RESTORABLE" in result.stderr
    assert available(database, eggs["food_id"]) == 0


def test_a_batch_whose_food_has_stock_again_is_not_restorable(database):
    home = household(database)
    flour = cooked_away(database, home, "Flour", "g", 200)
    add_lot(database, home, "Flour", "g", 300, "pantry")

    result = restore(database, home, flour["lot_id"], 200, check=False)

    assert "LOT_NOT_RESTORABLE" in result.stderr
    assert available(database, flour["food_id"]) == 300


def test_an_older_used_up_batch_of_the_food_is_not_restorable(database):
    home = household(database)
    first = add_lot(database, home, "Oats", "g", 200, expiration_date="2099-01-01")
    add_lot(database, home, "Oats", "g", 300, "pantry")
    database.run(
        f"UPDATE lots SET opened_at = now() - interval '1 day' WHERE id = {q(first['lot_id'])};"
    )
    cook_all_of(database, home, first["food_id"], 500)
    database.run(
        f"UPDATE lots SET depleted_at = now() - interval '1 hour' WHERE id = {q(first['lot_id'])};"
    )

    result = restore(database, home, first["lot_id"], 100, check=False)

    assert "LOT_NOT_RESTORABLE" in result.stderr
    assert available(database, first["food_id"]) == 0
