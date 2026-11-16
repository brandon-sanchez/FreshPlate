"""Lot outcome contract tests (deplete_lots, restore_lots, hard delete) against a disposable PostgreSQL cluster."""

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
        FOODS_MIGRATIONS + ("20261108140000_add_lot_outcomes.sql",)
    )


def ids(lot_ids: list[str]) -> str:
    return "ARRAY[" + ", ".join(q(i) for i in lot_ids) + "]::uuid[]"


def deplete(db: DB, home: str, lot_ids: list[str], reason: str, *, check=True, **who):
    sql = f"SELECT public.deplete_lots({q(home)}, {ids(lot_ids)}, {q(reason)});"
    return db.run(sql, check=check, **(who or AS_MEMBER))


def restore(db: DB, home: str, lot_ids: list[str], *, check=True, **who):
    sql = f"SELECT public.restore_lots({q(home)}, {ids(lot_ids)});"
    return db.run(sql, check=check, **(who or AS_MEMBER))


def lot(db: DB, lot_id: str):
    return db.json(
        f"SELECT row_to_json(l) FROM (SELECT quantity, depleted_at, depleted_reason FROM lots WHERE id = {q(lot_id)}) l"
    )


def available(db: DB, food_id: str):
    return db.json(f"SELECT available FROM food_stock WHERE id = {q(food_id)}")


def two_milk_lots(db: DB, home: str) -> tuple[str, list[str]]:
    first = add_lot(db, home, "Milk", "ml", 1000, expiration_date="2099-01-01")
    second = add_lot(db, home, "Milk", "ml", 500, "freezer")
    return first["food_id"], [first["lot_id"], second["lot_id"]]


@pytest.mark.parametrize("reason", ["used", "tossed"])
def test_depleting_records_the_reason_keeps_the_amount_and_leaves_stock(database, reason):
    home = household(database)
    added = add_lot(database, home, "Butter", "g", 250)

    deplete(database, home, [added["lot_id"]], reason)

    row = lot(database, added["lot_id"])
    assert (row["quantity"], row["depleted_reason"]) == (250, reason)
    assert row["depleted_at"] is not None
    assert available(database, added["food_id"]) == 0


def test_restore_brings_depleted_lots_back_into_stock(database):
    home = household(database)
    food, lot_ids = two_milk_lots(database, home)
    deplete(database, home, lot_ids, "tossed")
    assert available(database, food) == 0

    restore(database, home, lot_ids)

    assert available(database, food) == 1500
    assert all(lot(database, i)["depleted_reason"] is None for i in lot_ids)


def test_several_lots_deplete_together_even_with_repeated_ids(database):
    home = household(database)
    food, lot_ids = two_milk_lots(database, home)

    deplete(database, home, [*lot_ids, lot_ids[0]], "used")

    assert [lot(database, i)["depleted_reason"] for i in lot_ids] == ["used", "used"]
    assert available(database, food) == 0


def test_one_non_live_lot_in_the_batch_changes_nothing(database):
    home = household(database)
    food, lot_ids = two_milk_lots(database, home)
    deplete(database, home, [lot_ids[0]], "used")

    result = deplete(database, home, lot_ids, "tossed", check=False)

    assert result.returncode != 0 and "LOT_NOT_LIVE" in result.stderr
    assert lot(database, lot_ids[0])["depleted_reason"] == "used"
    assert lot(database, lot_ids[1])["depleted_at"] is None
    assert available(database, food) == 500


def test_unknown_lot_ids_are_refused(database):
    home = household(database)
    _, lot_ids = two_milk_lots(database, home)

    result = deplete(database, home, [lot_ids[0], "00000000-0000-0000-0000-0000000000ff"], "used", check=False)

    assert "LOT_NOT_LIVE" in result.stderr
    assert lot(database, lot_ids[0])["depleted_at"] is None


@pytest.mark.parametrize(
    "call",
    [
        "SELECT public.deplete_lots({home}, ARRAY[{lot}]::uuid[], 'corrected')",
        "SELECT public.deplete_lots({home}, ARRAY[{lot}]::uuid[], NULL)",
        "SELECT public.deplete_lots({home}, ARRAY[]::uuid[], 'used')",
        "SELECT public.deplete_lots({home}, NULL, 'used')",
        "SELECT public.deplete_lots({home}, ARRAY[{lot}, NULL]::uuid[], 'used')",
        "SELECT public.restore_lots({home}, ARRAY[]::uuid[])",
        "SELECT public.restore_lots({home}, ARRAY[NULL]::uuid[])",
    ],
)
def test_bad_arguments_are_refused_as_invalid(database, call):
    home = household(database)
    added = add_lot(database, home, "Rice", "g", 1000)

    sql = call.format(home=q(home), lot=q(added["lot_id"]))

    result = database.run("\\set VERBOSITY verbose\n" + sql + ";", check=False, **AS_MEMBER)

    assert "ERROR:  22023" in result.stderr
    assert lot(database, added["lot_id"])["depleted_at"] is None


def test_restore_refuses_lots_depleted_more_than_14_days_ago(database):
    home = household(database)
    food, lot_ids = two_milk_lots(database, home)
    deplete(database, home, lot_ids, "used")
    database.run(f"UPDATE lots SET depleted_at = now() - interval '15 days' WHERE id = {q(lot_ids[0])}")

    result = restore(database, home, lot_ids, check=False)

    assert "LOT_NOT_RESTORABLE" in result.stderr
    assert available(database, food) == 0


def test_restore_refuses_a_live_lot(database):
    home = household(database)
    _, lot_ids = two_milk_lots(database, home)

    result = restore(database, home, [lot_ids[0]], check=False)

    assert "LOT_NOT_RESTORABLE" in result.stderr


@pytest.mark.parametrize(
    "who",
    [
        {"role": "anon", "user": None},
        {"role": "authenticated", "user": None},
        {"role": "authenticated", "user": OTHER},
    ],
    ids=["anon", "signed-out", "other-household"],
)
def test_outsiders_cannot_deplete_or_restore(database, who):
    home = household(database)
    food, lot_ids = two_milk_lots(database, home)

    assert deplete(database, home, lot_ids, "tossed", check=False, **who).returncode != 0
    assert available(database, food) == 1500

    deplete(database, home, lot_ids, "tossed")
    assert restore(database, home, lot_ids, check=False, **who).returncode != 0
    assert available(database, food) == 0


def test_a_member_of_one_household_cannot_deplete_another_households_lots(database):
    home = household(database)
    other_home = household(database, OTHER)
    _, lot_ids = two_milk_lots(database, home)

    result = deplete(database, other_home, lot_ids, "tossed", check=False, role="authenticated", user=OTHER)

    assert "LOT_NOT_LIVE" in result.stderr
    assert all(lot(database, i)["depleted_at"] is None for i in lot_ids)


def test_members_delete_their_households_lots_and_nobody_elses(database):
    home = household(database)
    household(database, OTHER)
    _, lot_ids = two_milk_lots(database, home)

    database.run(f"DELETE FROM lots WHERE id = {q(lot_ids[0])}", role="authenticated", user=OTHER)
    assert lot(database, lot_ids[0]) is not None

    database.run(f"DELETE FROM lots WHERE id = {q(lot_ids[0])}", **AS_MEMBER)
    assert lot(database, lot_ids[0]) is None
    assert lot(database, lot_ids[1]) is not None


def test_members_cannot_delete_a_depleted_lot(database):
    home = household(database)
    _, lot_ids = two_milk_lots(database, home)
    deplete(database, home, [lot_ids[0]], "tossed")

    database.run(f"DELETE FROM lots WHERE id = {q(lot_ids[0])}", **AS_MEMBER)

    assert lot(database, lot_ids[0])["depleted_reason"] == "tossed"


def test_a_member_of_one_household_cannot_restore_another_households_lots(database):
    home = household(database)
    other_home = household(database, OTHER)
    food, lot_ids = two_milk_lots(database, home)
    deplete(database, home, lot_ids, "tossed")

    result = restore(database, other_home, lot_ids, check=False, role="authenticated", user=OTHER)

    assert "LOT_NOT_RESTORABLE" in result.stderr
    assert available(database, food) == 0


def test_restore_refuses_a_depleted_lot_with_nothing_left(database):
    home = household(database)
    food, lot_ids = two_milk_lots(database, home)
    deplete(database, home, [lot_ids[0]], "used")
    database.run(f"UPDATE lots SET quantity = 0 WHERE id = {q(lot_ids[0])}")

    result = restore(database, home, [lot_ids[0]], check=False)

    assert "LOT_NOT_RESTORABLE" in result.stderr
    assert lot(database, lot_ids[0])["depleted_reason"] == "used"
    assert available(database, food) == 500
