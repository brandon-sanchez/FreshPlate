"""Contract tests for set_lot_remaining against a disposable PostgreSQL cluster."""

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
            "20261109090000_add_set_lot_remaining.sql",
        )
    )


def lot(db: DB, lot_id: str):
    return db.json(
        "SELECT row_to_json(l) FROM (SELECT quantity, is_estimate, opened_at, updated_at::text AS seen"
        f" FROM lots WHERE id = {q(lot_id)}) l"
    )


def set_remaining_sql(
    home: str, lot_id: str, seen: str, *, fraction=None, quantity=None
) -> str:
    return (
        f"SELECT public.set_lot_remaining({q(home)}, {q(lot_id)}, {lit(seen)}::timestamptz,"
        f" {lit(fraction)}::numeric, {lit(quantity)}::numeric);"
    )


def set_remaining(
    db: DB, home: str, lot_id: str, *, seen=None, check=True, who=AS_MEMBER, **amount
):
    seen = seen if seen is not None else lot(db, lot_id)["seen"]
    return db.run(set_remaining_sql(home, lot_id, seen, **amount), check=check, **who)


def milk(db: DB, home: str) -> str:
    return add_lot(db, home, "Milk", "ml", 1000)["lot_id"]


@pytest.mark.parametrize(
    ("fraction", "quantity", "estimate"),
    [(1, 1000, False), (0.75, 750, True), (0.5, 500, True), (0.25, 250, True)],
)
def test_a_fraction_sets_that_share_of_the_full_size(
    database, fraction, quantity, estimate
):
    home = household(database)
    milk_lot = milk(database, home)

    set_remaining(database, home, milk_lot, fraction=fraction)

    row = lot(database, milk_lot)
    assert (row["quantity"], row["is_estimate"]) == (quantity, estimate)


def test_an_exact_amount_is_stored_as_known(database):
    home = household(database)
    milk_lot = milk(database, home)
    set_remaining(database, home, milk_lot, fraction=0.5)

    set_remaining(database, home, milk_lot, quantity=320)

    row = lot(database, milk_lot)
    assert (row["quantity"], row["is_estimate"]) == (320, False)


def test_an_exact_amount_above_full_raises_the_full_size(database):
    home = household(database)
    jug = milk(database, home)

    set_remaining(database, home, jug, quantity=1500)
    set_remaining(database, home, jug, fraction=0.5)

    row = lot(database, jug)
    assert (row["quantity"], row["opened_at"] is not None) == (750, True)


def test_an_amount_below_full_marks_the_batch_opened(database):
    home = household(database)
    sealed, full = (
        milk(database, home),
        add_lot(database, home, "Oil", "ml", 500)["lot_id"],
    )

    set_remaining(database, home, sealed, fraction=0.75)
    set_remaining(database, home, full, fraction=1)

    assert lot(database, sealed)["opened_at"] is not None
    assert lot(database, full)["opened_at"] is None


def test_an_unknown_size_container_takes_a_fraction_of_one_container(database):
    home = household(database)
    salt = add_lot(database, home, "Salt", "each", 1, each_label="container")["lot_id"]

    set_remaining(database, home, salt, fraction=0.5)

    row = lot(database, salt)
    assert (row["quantity"], row["is_estimate"]) == (0.5, True)


def test_a_backfilled_batch_without_a_full_size_takes_only_an_exact_amount(database):
    home = household(database)
    salad = milk(database, home)
    database.run(
        f"UPDATE lots SET initial_quantity = NULL, quantity = 120 WHERE id = {q(salad)}"
    )

    refused = set_remaining(database, home, salad, fraction=0.5, check=False)
    set_remaining(database, home, salad, quantity=60)

    set_remaining(database, home, salad, quantity=200)

    assert "FULL_SIZE_UNKNOWN" in refused.stderr
    row = lot(database, salad)
    assert (row["quantity"], row["is_estimate"], row["opened_at"]) == (200, False, None)
    assert (
        "FULL_SIZE_UNKNOWN"
        in set_remaining(database, home, salad, fraction=1, check=False).stderr
    )


def test_a_write_based_on_an_old_read_is_refused_as_stale(database):
    home = household(database)
    milk_lot = milk(database, home)
    seen = lot(database, milk_lot)["seen"]
    set_remaining(database, home, milk_lot, fraction=0.5)

    result = set_remaining(
        database, home, milk_lot, seen=seen, fraction=0.25, check=False
    )

    assert "STALE" in result.stderr
    assert lot(database, milk_lot)["quantity"] == 500


def test_a_fill_sent_during_a_cook_on_another_phone_waits_and_is_refused(database):
    home = household(database)
    milk_lot = add_lot(database, home, "Milk", "ml", 2000)["lot_id"]
    seen = lot(database, milk_lot)["seen"]
    food = database.run(f"SELECT food_id FROM lots WHERE id = {q(milk_lot)}")
    cook = subprocess.Popen(
        [*PSQL, database.dsn],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    cook.stdin.write(
        f"BEGIN; SELECT FROM public.lock_foods(ARRAY[{q(food)}]::uuid[]);"
        f" UPDATE lots SET quantity = quantity - 1500 WHERE id = {q(milk_lot)};"
        " SELECT 'cooking'; SELECT pg_sleep(1); COMMIT;\n"
    )
    cook.stdin.flush()
    assert cook.stdout.readline().strip() == "cooking"

    result = set_remaining(
        database, home, milk_lot, seen=seen, fraction=0.5, check=False
    )
    cook.stdin.close()
    cook.wait(timeout=5)

    assert "STALE" in result.stderr
    assert lot(database, milk_lot)["quantity"] == 500


@pytest.mark.parametrize(
    "amount",
    [
        {},
        {"fraction": 0.5, "quantity": 500},
        {"fraction": 0},
        {"fraction": 1.5},
        {"fraction": "NaN"},
        {"quantity": 0},
        {"quantity": -1},
        {"quantity": "NaN"},
        {"quantity": "Infinity"},
    ],
)
def test_bad_amounts_are_refused_as_invalid(database, amount):
    home = household(database)
    milk_lot = milk(database, home)

    result = database.run(
        "\\set VERBOSITY verbose\n"
        + set_remaining_sql(home, milk_lot, lot(database, milk_lot)["seen"], **amount),
        check=False,
        **AS_MEMBER,
    )

    assert "ERROR:  22023" in result.stderr
    assert lot(database, milk_lot)["quantity"] == 1000


def test_a_used_up_batch_is_not_live(database):
    home = household(database)
    milk_lot = milk(database, home)
    database.run(
        f"SELECT public.deplete_lots({q(home)}, ARRAY[{q(milk_lot)}]::uuid[], 'used')",
        **AS_MEMBER,
    )

    result = set_remaining(database, home, milk_lot, fraction=0.5, check=False)

    assert "LOT_NOT_LIVE" in result.stderr


def test_a_whole_units_only_food_refuses_a_fractional_amount(database):
    home = household(database)
    cans = add_lot(
        database, home, "Beans", "each", 1, each_label="can", whole_units_only=True
    )["lot_id"]

    result = set_remaining(database, home, cans, fraction=0.5, check=False)

    assert "whole units only" in result.stderr
    assert lot(database, cans)["quantity"] == 1


@pytest.mark.parametrize(
    "who",
    [
        {"role": "anon", "user": None},
        {"role": "authenticated", "user": None},
        {"role": "authenticated", "user": OTHER},
    ],
    ids=["anon", "signed-out", "other-household"],
)
def test_outsiders_cannot_set_a_batchs_amount(database, who):
    home = household(database)
    milk_lot = milk(database, home)

    result = set_remaining(database, home, milk_lot, fraction=0.5, check=False, who=who)

    assert result.returncode != 0
    assert lot(database, milk_lot)["quantity"] == 1000


def test_a_member_of_one_household_cannot_set_another_households_batch(database):
    home = household(database)
    other_home = household(database, OTHER)
    milk_lot = milk(database, home)

    result = set_remaining(
        database,
        other_home,
        milk_lot,
        fraction=0.5,
        check=False,
        who={"role": "authenticated", "user": OTHER},
    )

    assert "LOT_NOT_LIVE" in result.stderr
    assert lot(database, milk_lot)["quantity"] == 1000
