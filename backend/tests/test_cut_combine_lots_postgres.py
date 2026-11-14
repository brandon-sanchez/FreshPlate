"""Contract tests for cut_lot, combine_lots and add_to_lot against a disposable PostgreSQL cluster."""

# ruff: noqa: E501

from __future__ import annotations

import subprocess

import pytest

from tests.pg_support import (
    DB,
    DSN,
    FOODS_MIGRATIONS,
    OTHER,
    PSQL,
    USER,
    add_lot,
    disposable_database,
    household,
    lit,
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
            "20261110120000_add_cut_and_combine_lots.sql",
        )
    )


def lot(db: DB, lot_id: str):
    return db.json(
        "SELECT row_to_json(l) FROM (SELECT food_id, quantity, initial_quantity, is_estimate,"
        " expiration_date::text AS expiration_date, opened_at IS NOT NULL AS opened,"
        " storage_location, depleted_at IS NOT NULL AS depleted"
        f" FROM lots WHERE id = {q(lot_id)}) l"
    )


def live_lots(db: DB, food_id: str) -> int:
    return int(
        db.run(
            f"SELECT count(*) FROM lots WHERE food_id = {q(food_id)} AND depleted_at IS NULL"
        )
    )


def cut(
    db: DB,
    home: str,
    lot_id: str,
    quantity,
    expiration_date=None,
    *,
    check=True,
    who=AS_MEMBER,
):
    sql = (
        f"SELECT public.cut_lot({q(home)}, {q(lot_id)}, {lit(quantity)}::numeric,"
        f" {lit(expiration_date)}::date);"
    )
    return db.run(sql, check=check, **who)


def combine(
    db: DB, home: str, into: str, lot_ids: list[str], *, check=True, who=AS_MEMBER
):
    ids = ", ".join(q(i) for i in lot_ids)
    sql = f"SELECT public.combine_lots({q(home)}, {q(into)}, ARRAY[{ids}]::uuid[]);"
    return db.run(sql, check=check, **who)


def add_to(
    db: DB,
    home: str,
    lot_id: str,
    stock_base: str,
    quantity,
    expiration_date=None,
    each_label=None,
    *,
    check=True,
    who=AS_MEMBER,
):
    sql = (
        f"SELECT public.add_to_lot(p_household_id => {q(home)}, p_lot_id => {q(lot_id)},"
        f" p_stock_base => {lit(stock_base)}, p_quantity => {lit(quantity)},"
        f" p_expiration_date => {lit(expiration_date)}, p_each_label => {lit(each_label)});"
    )
    return db.run(sql, check=check, **who)


def apples(db: DB, home: str, count=5, date="2030-01-10", location="pantry") -> str:
    return add_lot(
        db,
        home,
        "Apple",
        "each",
        count,
        location,
        each_label="apple",
        whole_units_only=True,
        expiration_date=date,
    )["lot_id"]


def test_cutting_part_of_a_batch_makes_an_opened_batch_and_keeps_the_total(database):
    home = household(database)
    whole = apples(database, home)

    piece = cut(database, home, whole, 1, "2030-01-03")

    assert lot(database, whole) | {"food_id": None} == {
        "food_id": None,
        "quantity": 4,
        "initial_quantity": 4,
        "is_estimate": False,
        "expiration_date": "2030-01-10",
        "opened": False,
        "storage_location": "pantry",
        "depleted": False,
    }
    cut_part = lot(database, piece)
    assert (cut_part["quantity"], cut_part["initial_quantity"], cut_part["opened"]) == (
        1,
        1,
        True,
    )
    assert (cut_part["expiration_date"], cut_part["storage_location"]) == (
        "2030-01-03",
        "pantry",
    )
    assert cut_part["food_id"] == lot(database, whole)["food_id"]


def test_a_cut_batch_never_gets_a_later_date_than_the_original(database):
    home = household(database)
    whole = apples(database, home, date="2030-01-10")

    later = cut(database, home, whole, 1, "2030-02-01")
    undated = cut(database, home, whole, 1)

    assert lot(database, later)["expiration_date"] == "2030-01-10"
    assert lot(database, undated)["expiration_date"] == "2030-01-10"


def test_cutting_an_undated_batch_takes_the_given_date(database):
    home = household(database)
    whole = apples(database, home, date=None)

    piece = cut(database, home, whole, 2, "2030-01-03")

    assert lot(database, piece)["expiration_date"] == "2030-01-03"


def test_cutting_the_whole_batch_opens_it_in_place(database):
    home = household(database)
    melon = add_lot(
        database,
        home,
        "Melon",
        "each",
        1,
        each_label="melon",
        expiration_date="2030-01-10",
    )["lot_id"]

    result = cut(database, home, melon, 1, "2030-01-04")

    assert result == melon
    row = lot(database, melon)
    assert (row["quantity"], row["opened"], row["expiration_date"]) == (
        1,
        True,
        "2030-01-04",
    )
    assert live_lots(database, row["food_id"]) == 1


def test_cutting_from_a_partly_used_container_keeps_its_size(database):
    home = household(database)
    juice = add_lot(database, home, "Juice", "ml", 1000)["lot_id"]
    database.run(f"UPDATE lots SET quantity = 600 WHERE id = {q(juice)}")

    cut(database, home, juice, 200)

    row = lot(database, juice)
    assert (row["quantity"], row["initial_quantity"]) == (400, 1000)


def test_pouring_from_a_sealed_bottle_opens_it_so_new_bottles_stay_apart(database):
    home = household(database)
    bottle = add_lot(database, home, "Juice", "ml", 1000)["lot_id"]

    cut(database, home, bottle, 200)
    added = add_lot(database, home, "Juice", "ml", 800)

    row = lot(database, bottle)
    assert (row["quantity"], row["initial_quantity"], row["opened"]) == (
        800,
        1000,
        True,
    )
    assert (added["lot_merged"], added["lot_id"] != bottle) == (False, True)


def test_cutting_more_than_is_left_is_refused(database):
    home = household(database)
    whole = apples(database, home, count=2)

    result = cut(database, home, whole, 3, check=False)

    assert "NOT_ENOUGH_LEFT" in result.stderr
    assert lot(database, whole)["quantity"] == 2


@pytest.mark.parametrize("quantity", [None, 0, -1, "NaN", "Infinity"])
def test_a_bad_cut_amount_is_refused_as_invalid(database, quantity):
    home = household(database)
    whole = apples(database, home)

    result = database.run(
        "\\set VERBOSITY verbose\n"
        f"SELECT public.cut_lot({q(home)}, {q(whole)}, {lit(quantity)}::numeric, NULL);",
        check=False,
        **AS_MEMBER,
    )

    assert "ERROR:  22023" in result.stderr
    assert lot(database, whole)["quantity"] == 5


def test_a_whole_units_only_food_refuses_a_fractional_cut(database):
    home = household(database)
    whole = apples(database, home)

    result = cut(database, home, whole, 0.5, check=False)

    assert "whole units only" in result.stderr
    assert lot(database, whole)["quantity"] == 5


def test_a_used_up_batch_cannot_be_cut(database):
    home = household(database)
    whole = apples(database, home)
    database.run(
        f"SELECT public.deplete_lots({q(home)}, ARRAY[{q(whole)}]::uuid[], 'used')",
        **AS_MEMBER,
    )

    assert "LOT_NOT_LIVE" in cut(database, home, whole, 1, check=False).stderr


def test_combining_batches_adds_amounts_opens_and_takes_the_earliest_date(database):
    home = household(database)
    tray = add_lot(
        database,
        home,
        "Eggs",
        "each",
        4,
        each_label="egg",
        expiration_date="2030-01-20",
    )["lot_id"]
    carton = add_lot(
        database,
        home,
        "Eggs",
        "each",
        12,
        each_label="egg",
        expiration_date="2030-01-08",
    )["lot_id"]
    loose = add_lot(database, home, "Eggs", "each", 2, "pantry", each_label="egg")[
        "lot_id"
    ]

    result = combine(database, home, tray, [carton, loose, tray])

    assert result == tray
    row = lot(database, tray)
    assert row | {"food_id": None} == {
        "food_id": None,
        "quantity": 18,
        "initial_quantity": 18,
        "is_estimate": False,
        "expiration_date": "2030-01-08",
        "opened": True,
        "storage_location": "fridge",
        "depleted": False,
    }
    assert live_lots(database, row["food_id"]) == 1
    assert (
        database.run(
            f"SELECT string_agg(depleted_reason || ':' || quantity, ',') FROM lots WHERE id IN ({q(carton)}, {q(loose)})"
        )
        == "combined:0,combined:0"
    )


def test_combined_batches_cannot_be_restored(database):
    home = household(database)
    pitcher = add_lot(database, home, "Juice", "ml", 500)["lot_id"]
    carton = add_lot(database, home, "Juice", "ml", 1000, "pantry")["lot_id"]
    combine(database, home, pitcher, [carton])

    result = database.run(
        f"SELECT public.restore_lots({q(home)}, ARRAY[{q(carton)}]::uuid[])",
        check=False,
        **AS_MEMBER,
    )

    assert "LOT_NOT_RESTORABLE" in result.stderr
    assert lot(database, pitcher)["quantity"] == 1500


def test_combining_keeps_a_full_size_that_is_bigger_than_the_total(database):
    home = household(database)
    jug = add_lot(database, home, "Horchata", "ml", 2000)["lot_id"]
    database.run(
        f"UPDATE lots SET quantity = 500, is_estimate = true WHERE id = {q(jug)}"
    )
    carton = add_lot(database, home, "Horchata", "ml", 1000, "pantry")["lot_id"]

    combine(database, home, jug, [carton])

    row = lot(database, jug)
    assert (row["quantity"], row["initial_quantity"], row["is_estimate"]) == (
        1500,
        2000,
        True,
    )


def test_combining_into_a_batch_of_unknown_full_size_keeps_it_unknown(database):
    home = household(database)
    canister = add_lot(database, home, "Cereal", "g", 300)["lot_id"]
    database.run(f"UPDATE lots SET initial_quantity = NULL WHERE id = {q(canister)}")
    box = add_lot(database, home, "Cereal", "g", 500, "pantry")["lot_id"]

    combine(database, home, canister, [box])

    row = lot(database, canister)
    assert (row["quantity"], row["initial_quantity"]) == (800, None)


def test_batches_of_different_foods_cannot_be_combined(database):
    home = household(database)
    milk = add_lot(database, home, "Milk", "ml", 1000)["lot_id"]
    juice = add_lot(database, home, "Juice", "ml", 1000)["lot_id"]

    result = combine(database, home, milk, [juice], check=False)

    assert "DIFFERENT_FOODS" in result.stderr
    assert lot(database, juice)["depleted"] is False


@pytest.mark.parametrize(
    "ids", ["ARRAY[]::uuid[]", "NULL::uuid[]", "ARRAY[NULL]::uuid[]", "into"]
)
def test_combining_needs_at_least_one_other_batch(database, ids):
    home = household(database)
    milk = add_lot(database, home, "Milk", "ml", 1000)["lot_id"]
    ids = f"ARRAY[{q(milk)}]::uuid[]" if ids == "into" else ids

    result = database.run(
        "\\set VERBOSITY verbose\n"
        f"SELECT public.combine_lots({q(home)}, {q(milk)}, {ids});",
        check=False,
        **AS_MEMBER,
    )

    assert "ERROR:  22023" in result.stderr


def test_combining_a_used_up_batch_is_refused_and_changes_nothing(database):
    home = household(database)
    pitcher = add_lot(database, home, "Juice", "ml", 500)["lot_id"]
    gone = add_lot(database, home, "Juice", "ml", 1000, "pantry")["lot_id"]
    database.run(
        f"SELECT public.deplete_lots({q(home)}, ARRAY[{q(gone)}]::uuid[], 'used')",
        **AS_MEMBER,
    )

    result = combine(database, home, pitcher, [gone], check=False)

    assert "LOT_NOT_LIVE" in result.stderr
    assert lot(database, pitcher)["quantity"] == 500


def test_adding_to_an_existing_container_tops_it_up(database):
    home = household(database)
    jug = add_lot(database, home, "Horchata", "ml", 1000, expiration_date="2030-01-09")[
        "lot_id"
    ]
    database.run(f"UPDATE lots SET quantity = 400 WHERE id = {q(jug)}")

    add_to(database, home, jug, "ml", 1000, "2030-01-05")

    row = lot(database, jug)
    assert (row["quantity"], row["initial_quantity"], row["opened"]) == (
        1400,
        1400,
        True,
    )
    assert row["expiration_date"] == "2030-01-05"
    assert live_lots(database, row["food_id"]) == 1


def test_adding_to_a_container_keeps_its_date_when_the_new_food_is_newer(database):
    home = household(database)
    tray = add_lot(
        database,
        home,
        "Eggs",
        "each",
        3,
        each_label="egg",
        expiration_date="2030-01-09",
    )["lot_id"]

    add_to(database, home, tray, "each", 12, "2030-02-01", each_label="Egg")

    row = lot(database, tray)
    assert (row["quantity"], row["expiration_date"]) == (15, "2030-01-09")


def test_adding_to_a_container_in_another_unit_is_refused(database):
    home = household(database)
    jug = add_lot(database, home, "Horchata", "ml", 1000)["lot_id"]

    result = add_to(database, home, jug, "each", 1, each_label="can", check=False)

    assert "STOCK_BASE_MISMATCH" in result.stderr
    assert lot(database, jug)["quantity"] == 1000


@pytest.mark.parametrize("quantity", [None, 0, -2, "NaN"])
def test_a_bad_top_up_amount_is_refused_as_invalid(database, quantity):
    home = household(database)
    jug = add_lot(database, home, "Horchata", "ml", 1000)["lot_id"]

    result = database.run(
        "\\set VERBOSITY verbose\n"
        f"SELECT public.add_to_lot({q(home)}, {q(jug)}, 'ml', {lit(quantity)}::numeric);",
        check=False,
        **AS_MEMBER,
    )

    assert "ERROR:  22023" in result.stderr


def test_a_cut_sent_during_a_cook_on_another_phone_waits_for_its_food_lock(database):
    home = household(database)
    whole = apples(database, home, count=3)
    food = lot(database, whole)["food_id"]
    cook = subprocess.Popen(
        [*PSQL, database.dsn],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    cook.stdin.write(
        f"BEGIN; SELECT FROM public.lock_foods(ARRAY[{q(food)}]::uuid[]);"
        " SELECT 'cooking'; SELECT pg_sleep(1);"
        f" UPDATE lots SET quantity = quantity - 2 WHERE id = {q(whole)}; COMMIT;\n"
    )
    cook.stdin.flush()
    assert cook.stdout.readline().strip() == "cooking"

    result = cut(database, home, whole, 2, check=False)
    cook.stdin.close()
    cook.wait(timeout=5)

    assert "NOT_ENOUGH_LEFT" in result.stderr
    assert lot(database, whole)["quantity"] == 1


CALLS = {
    "cut": lambda db, home, lots, who: cut(db, home, lots[0], 1, check=False, who=who),
    "combine": lambda db, home, lots, who: combine(
        db, home, lots[0], [lots[1]], check=False, who=who
    ),
    "add_to": lambda db, home, lots, who: add_to(
        db, home, lots[0], "ml", 1, check=False, who=who
    ),
}


@pytest.mark.parametrize("call", CALLS)
@pytest.mark.parametrize(
    "who",
    [
        {"role": "anon", "user": None},
        {"role": "authenticated", "user": None},
        {"role": "authenticated", "user": OTHER},
    ],
    ids=["anon", "signed-out", "other-household"],
)
def test_outsiders_cannot_change_a_households_batches(database, call, who):
    home = household(database)
    lots = [
        add_lot(database, home, "Milk", "ml", 1000, loc)["lot_id"]
        for loc in ("fridge", "pantry")
    ]

    result = CALLS[call](database, home, lots, who)

    assert result.returncode != 0
    assert [lot(database, i)["quantity"] for i in lots] == [1000, 1000]


@pytest.mark.parametrize("call", CALLS)
def test_a_member_cannot_reach_another_households_batches(database, call):
    home = household(database)
    other_home = household(database, OTHER)
    lots = [
        add_lot(database, home, "Milk", "ml", 1000, loc)["lot_id"]
        for loc in ("fridge", "pantry")
    ]

    result = CALLS[call](
        database, other_home, lots, {"role": "authenticated", "user": OTHER}
    )

    assert "LOT_NOT_LIVE" in result.stderr
    assert [lot(database, i)["quantity"] for i in lots] == [1000, 1000]


def test_members_cannot_pour_into_a_batch_without_its_checks(database):
    home = household(database)
    jug = add_lot(database, home, "Milk", "ml", 1000)["lot_id"]

    result = database.run(
        f"SELECT public.pour_into_lot({q(jug)}, 5000, NULL, now(), false);",
        check=False,
        **AS_MEMBER,
    )

    assert "permission denied" in result.stderr
    assert lot(database, jug)["quantity"] == 1000
