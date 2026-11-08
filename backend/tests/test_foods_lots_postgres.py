"""Foods-and-lots schema and add_lot contract tests against a disposable PostgreSQL cluster."""

# SQL fixture strings are intentionally kept readable at their database shape.
# ruff: noqa: E501

from __future__ import annotations

import subprocess
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import date, timedelta

import pytest

from tests.pg_support import (
    DB,
    DSN,
    FOODS_MIGRATIONS,
    OTHER,
    PSQL,
    USER,
    add_lot,
    add_lot_sql,
    disposable_database,
    household,
    q,
    session_prefix,
)

pytestmark = pytest.mark.skipif(not DSN, reason="Requires disposable local PostgreSQL")


@pytest.fixture(scope="module")
def database():
    yield from disposable_database(FOODS_MIGRATIONS)


@pytest.fixture(scope="module")
def today(database) -> date:
    return date.fromisoformat(database.run("SELECT current_date"))


def stock(db: DB, food_id: str):
    return db.json(f"SELECT row_to_json(s) FROM food_stock s WHERE id = {q(food_id)}")


def lots(db: DB, food_id: str):
    return db.json(
        f"SELECT coalesce(json_agg(l ORDER BY l.created_at, l.id), '[]') FROM lots l WHERE food_id = {q(food_id)}"
    )


def count(db: DB, sql: str, **kwargs) -> int:
    return int(db.run(f"SELECT count(*) FROM {sql}", **kwargs))


def while_holding(db: DB, hold_sql: str, action, *, role=None, user=None):
    """Run action while another session holds hold_sql's locks in an open transaction.

    Commits the holder only after action is seen waiting on a lock, so every
    caller exercises real overlap, then returns action's result.
    """
    proc = subprocess.Popen(
        [*PSQL, db.dsn],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
    )
    proc.stdin.write(session_prefix(role, user) + f"BEGIN; {hold_sql} SELECT 'holding';\n")
    proc.stdin.flush()
    while (line := proc.stdout.readline()) and line.strip() != "holding":
        pass
    assert line.strip() == "holding", proc.stderr.read()
    with ThreadPoolExecutor(max_workers=1) as pool:
        future = pool.submit(action)
        deadline = time.monotonic() + 5
        waiting = "SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'"
        while db.run(waiting) == "0":
            assert time.monotonic() < deadline and not future.done(), "action never waited on the held lock"
            time.sleep(0.05)
        proc.stdin.write("COMMIT;\n")
        proc.stdin.close()
        assert proc.wait(timeout=10) == 0, proc.stderr.read()
        return future.result(timeout=10)


def test_food_name_key_ignores_case_and_spacing(database):
    assert database.run("SELECT public.food_name_key('  Green \t  ONIONS ')") == "green onions"


def test_new_food_creates_food_and_lot_reported_by_stock(database, today):
    home = household(database)
    expiry = today + timedelta(days=5)
    result = add_lot(database, home, "Milk", "ml", 1000, expiration_date=expiry)
    assert result["food_created"] is True
    assert result["lot_merged"] is False
    row = stock(database, result["food_id"])
    assert (row["name"], row["stock_base"], row["available"], row["lot_count"]) == ("Milk", "ml", 1000, 1)
    assert (row["soonest_expiry"], row["expired_quantity"], row["any_estimate"]) == (expiry.isoformat(), 0, False)
    [lot] = lots(database, result["food_id"])
    assert (lot["id"], lot["quantity"], lot["initial_quantity"], lot["added_by"]) == (result["lot_id"], 1000, 1000, USER)


def test_same_name_date_and_location_merges_into_one_lot(database, today):
    home = household(database)
    expiry = today + timedelta(days=5)
    first = add_lot(database, home, "Milk", "ml", 1000, expiration_date=expiry)
    second = add_lot(database, home, "  mILK   ", "ml", 500, expiration_date=expiry)
    assert second == {
        "food_id": first["food_id"], "lot_id": first["lot_id"],
        "food_created": False, "lot_merged": True,
    }
    [lot] = lots(database, first["food_id"])
    assert (lot["quantity"], lot["initial_quantity"]) == (1500, 1500)
    assert count(database, f"foods WHERE household_id = {q(home)}") == 1


def test_different_date_or_location_starts_a_new_lot(database, today):
    home = household(database)
    later, sooner = today + timedelta(days=9), today + timedelta(days=3)
    first = add_lot(database, home, "Milk", "ml", 1000, expiration_date=later)
    second = add_lot(database, home, "Milk", "ml", 1000, expiration_date=sooner)
    third = add_lot(database, home, "Milk", "ml", 1000, "freezer", expiration_date=later)
    assert second["food_id"] == third["food_id"] == first["food_id"]
    assert len({first["lot_id"], second["lot_id"], third["lot_id"]}) == 3
    row = stock(database, first["food_id"])
    assert (row["available"], row["lot_count"], row["soonest_expiry"]) == (3000, 3, sooner.isoformat())


def test_opened_lot_is_not_a_merge_target(database):
    home = household(database)
    first = add_lot(database, home, "Rice", "g", 500, "pantry")
    database.run(f"UPDATE lots SET opened_at = now() WHERE id = {q(first['lot_id'])}")
    second = add_lot(database, home, "Rice", "g", 500, "pantry")
    assert second["lot_merged"] is False
    assert second["lot_id"] != first["lot_id"]


def test_partly_used_or_backfilled_lots_are_not_merge_targets(database):
    home = household(database)
    first = add_lot(database, home, "Oil", "ml", 1000, "pantry")
    database.run(f"UPDATE lots SET quantity = 400 WHERE id = {q(first['lot_id'])}")
    backfilled = database.run(
        f"INSERT INTO lots(food_id, household_id, quantity, storage_location, expiration_date) VALUES ({q(first['food_id'])}, {q(home)}, 200, 'pantry', '2031-01-01') RETURNING id"
    ).splitlines()[0]
    after_use = add_lot(database, home, "Oil", "ml", 1000, "pantry")
    after_backfill = add_lot(database, home, "Oil", "ml", 1000, "pantry", expiration_date="2031-01-01")
    assert after_use["lot_merged"] is False and after_use["lot_id"] != first["lot_id"]
    assert after_backfill["lot_merged"] is False and after_backfill["lot_id"] != backfilled
    assert sorted(lot["quantity"] for lot in lots(database, first["food_id"])) == [200, 400, 1000, 1000]


def test_package_label_and_notes_decide_merging(database):
    home = household(database)
    first = add_lot(database, home, "Soda", "each", 6, "pantry", each_label="can", package_label=" Can ", notes="cola")
    assert add_lot(database, home, "Soda", "each", 6, "pantry", each_label="can", package_label="can")["lot_id"] == first["lot_id"]
    assert add_lot(database, home, "Soda", "each", 6, "pantry", each_label="can", package_label="CAN", notes="cola")["lot_id"] == first["lot_id"]
    other_note = add_lot(database, home, "Soda", "each", 6, "pantry", each_label="can", package_label="can", notes="lemon")
    assert other_note["lot_id"] != first["lot_id"]
    unlabeled = add_lot(database, home, "Water", "each", 1, "pantry", each_label="bottle", package_label="")
    assert add_lot(database, home, "Water", "each", 1, "pantry", each_label="bottle")["lot_id"] == unlabeled["lot_id"]
    assert [(lot["quantity"], lot["notes"]) for lot in lots(database, first["food_id"])] == [(18, "cola"), (6, "lemon")]


def test_stock_counts_expired_apart_and_skips_depleted_lots(database, today):
    home = household(database)
    fresh = add_lot(database, home, "Yogurt", "g", 300, expiration_date=today + timedelta(days=4))
    food = fresh["food_id"]
    add_lot(database, home, "Yogurt", "g", 200, expiration_date=today - timedelta(days=1))
    add_lot(database, home, "Yogurt", "g", 100, expiration_date=today + timedelta(days=8), is_estimate=True)
    used = add_lot(database, home, "Yogurt", "g", 50, expiration_date=today + timedelta(days=2))
    database.run(f"UPDATE lots SET quantity = 0, depleted_at = now(), depleted_reason = 'used' WHERE id = {q(used['lot_id'])}")
    row = stock(database, food)
    assert (row["available"], row["expired_quantity"], row["lot_count"]) == (400, 200, 3)
    assert (row["soonest_expiry"], row["any_estimate"]) == ((today + timedelta(days=4)).isoformat(), True)


def test_archived_food_leaves_stock_and_returns_when_added_again(database):
    home = household(database)
    first = add_lot(database, home, "Basil", "g", 30)
    database.run(f"UPDATE foods SET archived_at = now() WHERE id = {q(first['food_id'])}")
    assert stock(database, first["food_id"]) is None
    again = add_lot(database, home, "basil", "g", 20, "pantry")
    assert (again["food_id"], again["food_created"]) == (first["food_id"], False)
    assert stock(database, first["food_id"])["available"] == 50


def test_merged_food_name_lands_on_the_merge_target(database):
    home = household(database)
    target = add_lot(database, home, "Green onions", "each", 4, each_label="bunch")["food_id"]
    old = add_lot(database, home, "Scallions", "each", 1, each_label="bunch")["food_id"]
    database.run(f"UPDATE foods SET archived_at = now(), merged_into_id = {q(target)} WHERE id = {q(old)}")
    result = add_lot(database, home, "scallions", "each", 2, "pantry", each_label=" Bunch ")
    assert (result["food_id"], result["food_created"]) == (target, False)
    assert stock(database, target)["available"] == 6
    assert stock(database, old) is None


@pytest.mark.parametrize(
    ("stock_base", "each_label"), [("g", None), ("each", "carton")]
)
def test_stock_base_mismatch_leaves_stock_unchanged(database, stock_base, each_label):
    home = household(database)
    first = add_lot(database, home, "Juice", "ml", 1000)
    failed = add_lot(database, home, "Juice", stock_base, 1, each_label=each_label, check=False)
    assert failed.returncode != 0
    assert "STOCK_BASE_MISMATCH" in failed.stderr
    assert "stored as ml" in failed.stderr
    assert [lot["quantity"] for lot in lots(database, first["food_id"])] == [1000]


def test_stock_base_is_fixed_once_any_lot_exists(database):
    home = household(database)
    food = database.run(
        f"INSERT INTO foods(household_id, name, stock_base) VALUES ({q(home)}, 'Flour', 'g') RETURNING id"
    ).splitlines()[0]
    database.run(f"UPDATE foods SET stock_base = 'ml' WHERE id = {q(food)}")
    database.run(f"UPDATE foods SET stock_base = 'g' WHERE id = {q(food)}")
    lot = add_lot(database, home, "Flour", "g", 1000, "pantry")["lot_id"]
    database.run(f"UPDATE lots SET quantity = 0, depleted_at = now(), depleted_reason = 'used' WHERE id = {q(lot)}")
    failed = database.run(f"UPDATE foods SET stock_base = 'ml' WHERE id = {q(food)}", check=False)
    assert failed.returncode != 0
    assert database.run(f"SELECT stock_base FROM foods WHERE id = {q(food)}") == "g"


def test_stock_base_change_waits_for_an_uncommitted_lot_and_fails(database):
    home = household(database)
    food = database.run(
        f"INSERT INTO foods(household_id, name, stock_base) VALUES ({q(home)}, 'Sugar', 'g') RETURNING id"
    ).splitlines()[0]
    failed = while_holding(
        database,
        f"INSERT INTO lots(food_id, household_id, quantity, storage_location) VALUES ({q(food)}, {q(home)}, 500, 'pantry');",
        lambda: database.run(f"UPDATE foods SET stock_base = 'ml' WHERE id = {q(food)}", check=False),
    )
    assert failed.returncode != 0
    assert database.run(f"SELECT stock_base FROM foods WHERE id = {q(food)}") == "g"


def test_whole_units_food_rejects_fractional_amounts(database):
    home = household(database)
    failed = add_lot(database, home, "Eggs", "each", 1.5, each_label="egg", whole_units_only=True, check=False)
    assert failed.returncode != 0
    assert count(database, f"foods WHERE household_id = {q(home)}") == 0
    eggs = add_lot(database, home, "Eggs", "each", 6, each_label="egg", whole_units_only=True)
    assert add_lot(database, home, "Eggs", "each", 0.5, each_label="egg", check=False).returncode != 0
    assert [lot["quantity"] for lot in lots(database, eggs["food_id"])] == [6]


def test_whole_units_flag_rejected_while_a_lot_is_fractional(database):
    home = household(database)
    cans = add_lot(database, home, "Beans", "each", 1.5, "pantry", each_label="can")["food_id"]
    failed = database.run(f"UPDATE foods SET whole_units_only = true WHERE id = {q(cans)}", check=False)
    assert failed.returncode != 0
    assert database.run(f"SELECT whole_units_only FROM foods WHERE id = {q(cans)}") == "f"


def test_fractional_lot_waits_for_a_concurrent_whole_units_switch_and_fails(database):
    home = household(database)
    cans = add_lot(database, home, "Tuna", "each", 2, "pantry", each_label="can")["food_id"]
    failed = while_holding(
        database,
        f"UPDATE foods SET whole_units_only = true WHERE id = {q(cans)};",
        lambda: database.run(
            f"INSERT INTO lots(food_id, household_id, quantity, storage_location) VALUES ({q(cans)}, {q(home)}, 0.5, 'pantry')",
            check=False,
        ),
    )
    assert failed.returncode != 0
    assert [lot["quantity"] for lot in lots(database, cans)] == [2]


@pytest.mark.parametrize("quantity", [0, -1, "NaN", "Infinity", "-Infinity", None])
def test_invalid_quantity_writes_nothing(database, quantity):
    home = household(database)
    failed = add_lot(database, home, "Oats", "g", quantity, "pantry", check=False)
    assert failed.returncode != 0
    assert count(database, f"foods WHERE household_id = {q(home)}") == 0
    assert count(database, f"lots WHERE household_id = {q(home)}") == 0


@pytest.mark.parametrize(
    ("name", "stock_base", "each_label"),
    [("   ", "g", None), ("\t", "g", None), ("\n \t", "g", None), ("x" * 81, "g", None), ("Eggs", "each", None), ("Eggs", "each", "  "), ("Rice", "g", "cup")],
)
def test_invalid_name_or_each_label_writes_nothing(database, name, stock_base, each_label):
    home = household(database)
    failed = add_lot(database, home, name, stock_base, 1, each_label=each_label, check=False)
    assert failed.returncode != 0
    assert count(database, f"foods WHERE household_id = {q(home)}") == 0


def test_whitespace_only_name_is_rejected_on_rename(database):
    home = household(database)
    food = add_lot(database, home, "Plums", "g", 300)["food_id"]
    failed = database.run(f"UPDATE foods SET name = E'\\t' WHERE id = {q(food)}", role="authenticated", user=USER, check=False)
    assert failed.returncode != 0
    assert stock(database, food)["name"] == "Plums"


def test_whole_units_on_a_weighed_food_is_an_argument_error(database):
    home = household(database)
    failed = add_lot(database, home, "Flour", "g", 500, "pantry", whole_units_only=True, check=False)
    assert "whole units only" in failed.stderr
    assert count(database, f"foods WHERE household_id = {q(home)}") == 0


def test_new_food_attributes_are_ignored_when_the_food_exists(database):
    home = household(database)
    first = add_lot(database, home, "Rice", "g", 500, "pantry")
    again = add_lot(database, home, "Rice", "g", 500, "pantry", grams_per_each=0)
    assert again["food_id"] == first["food_id"]
    assert stock(database, first["food_id"])["grams_per_each"] is None


def test_lot_constraints_on_depletion(database):
    home = household(database)
    food = add_lot(database, home, "Bread", "g", 400, "pantry")["food_id"]

    def insert(columns: str, values: str):
        return database.run(
            f"INSERT INTO lots(food_id, household_id, storage_location, {columns}) VALUES ({q(food)}, {q(home)}, 'pantry', {values})",
            check=False,
        )

    assert insert("quantity, depleted_at, depleted_reason", "120, now(), 'tossed'").returncode == 0
    assert insert("quantity", "0").returncode != 0
    assert insert("quantity, depleted_at", "0, now()").returncode != 0
    assert insert("quantity, depleted_reason", "10, 'used'").returncode != 0
    assert insert("quantity, depleted_at, depleted_reason", "0, now(), 'eaten'").returncode != 0
    assert count(database, f"lots WHERE food_id = {q(food)}") == 2


def test_other_household_sees_and_changes_nothing(database):
    home = household(database, USER)
    household(database, OTHER)
    added = add_lot(database, home, "Cheese", "g", 200)
    food, lot = added["food_id"], added["lot_id"]
    database.run(
        f"INSERT INTO food_units(food_id, household_id, unit_key, base_per_unit) VALUES ({q(food)}, {q(home)}, 'slice', 20)",
        role="authenticated", user=USER,
    )
    scope = f"WHERE household_id = {q(home)}"
    for table in ("foods", "lots", "food_units", "food_stock"):
        assert count(database, f"{table} {scope}", role="authenticated", user=USER) == 1
        assert count(database, f"{table} {scope}", role="authenticated", user=OTHER) == 0
    assert database.run(
        f"UPDATE lots SET expiration_date = current_date WHERE id = {q(lot)} RETURNING id",
        role="authenticated", user=OTHER,
    ) == ""
    foreign_unit = database.run(
        f"INSERT INTO food_units(food_id, household_id, unit_key, base_per_unit) VALUES ({q(food)}, {q(home)}, 'block', 200)",
        role="authenticated", user=OTHER, check=False,
    )
    assert foreign_unit.returncode != 0
    foreign_add = add_lot(database, home, "Cheese", "g", 50, user=OTHER, check=False)
    assert foreign_add.returncode != 0
    assert "membership" in foreign_add.stderr
    assert [row["quantity"] for row in lots(database, food)] == [200]


def test_anon_and_signed_out_callers_cannot_add_lots(database):
    home = household(database)
    assert add_lot(database, home, "Tea", "g", 100, "pantry", role="anon", user=None, check=False).returncode != 0
    signed_out = add_lot(database, home, "Tea", "g", 100, "pantry", user=None, check=False)
    assert signed_out.returncode != 0
    assert "Authentication required" in signed_out.stderr
    assert count(database, f"foods WHERE household_id = {q(home)}") == 0


def test_members_edit_lot_details_but_not_quantities_directly(database):
    home = household(database)
    added = add_lot(database, home, "Butter", "g", 250)
    food, lot = added["food_id"], added["lot_id"]
    as_user = {"role": "authenticated", "user": USER}
    direct_writes = [
        f"UPDATE lots SET quantity = 1 WHERE id = {q(lot)}",
        f"INSERT INTO lots(food_id, household_id, quantity, storage_location) VALUES ({q(food)}, {q(home)}, 5, 'fridge')",
        f"INSERT INTO foods(household_id, name, stock_base) VALUES ({q(home)}, 'Ghee', 'g')",
        f"UPDATE foods SET stock_base = 'ml' WHERE id = {q(food)}",
        f"DELETE FROM lots WHERE id = {q(lot)}",
    ]
    for sql in direct_writes:
        assert database.run(sql, check=False, **as_user).returncode != 0, sql
    database.run(f"UPDATE lots SET expiration_date = '2030-01-01', storage_location = 'freezer', notes = 'top shelf' WHERE id = {q(lot)}", **as_user)
    database.run(f"UPDATE foods SET name = 'Salted butter' WHERE id = {q(food)}", **as_user)
    [row] = lots(database, food)
    assert (row["quantity"], row["expiration_date"], row["storage_location"], row["notes"]) == (250, "2030-01-01", "freezer", "top shelf")
    assert stock(database, food)["name"] == "Salted butter"


def test_deleting_a_household_removes_its_foods_and_lots(database):
    home = household(database)
    food = add_lot(database, home, "Ham", "g", 200)["food_id"]
    database.run(f"INSERT INTO food_units(food_id, household_id, unit_key, base_per_unit) VALUES ({q(food)}, {q(home)}, 'slice', 25)")
    database.run(f"DELETE FROM households WHERE id = {q(home)}")
    for table in ("foods", "lots", "food_units"):
        assert count(database, f"{table} WHERE household_id = {q(home)}") == 0


@pytest.mark.parametrize(("second_offset", "expected_lots"), [(3, 1), (6, 2)])
def test_two_sessions_adding_the_same_new_food_both_succeed(database, today, second_offset, expected_lots):
    home = household(database)
    first_sql = add_lot_sql(home, "Horchata", "ml", 750, expiration_date=today + timedelta(days=3))
    second = while_holding(
        database, first_sql,
        lambda: add_lot(database, home, "horchata", "ml", 250, expiration_date=today + timedelta(days=second_offset)),
        role="authenticated", user=USER,
    )
    assert second["food_created"] is False
    assert second["lot_merged"] is (expected_lots == 1)
    assert count(database, f"foods WHERE household_id = {q(home)}") == 1
    food_lots = lots(database, second["food_id"])
    assert len(food_lots) == expected_lots
    assert sum(lot["quantity"] for lot in food_lots) == 1000


def test_add_through_a_merged_name_waits_for_a_stock_base_change(database):
    home = household(database)
    target = database.run(
        f"INSERT INTO foods(household_id, name, stock_base) VALUES ({q(home)}, 'Basmati', 'g') RETURNING id"
    ).splitlines()[0]
    database.run(
        f"INSERT INTO foods(household_id, name, stock_base, archived_at, merged_into_id) VALUES ({q(home)}, 'Basmati rice', 'g', now(), {q(target)})"
    )
    failed = while_holding(
        database,
        f"UPDATE foods SET stock_base = 'ml' WHERE id = {q(target)};",
        lambda: add_lot(database, home, "Basmati rice", "g", 500, "pantry", check=False),
    )
    assert "STOCK_BASE_MISMATCH" in failed.stderr
    assert lots(database, target) == []


def test_two_sessions_adding_a_new_date_to_an_existing_food_share_one_lot(database, today):
    home = household(database)
    food = add_lot(database, home, "Kefir", "ml", 500, expiration_date=today + timedelta(days=2))["food_id"]
    new_date = today + timedelta(days=10)
    second = while_holding(
        database, add_lot_sql(home, "Kefir", "ml", 500, expiration_date=new_date),
        lambda: add_lot(database, home, "Kefir", "ml", 300, expiration_date=new_date),
        role="authenticated", user=USER,
    )
    assert second["lot_merged"] is True
    assert sorted(lot["quantity"] for lot in lots(database, food)) == [500, 800]
