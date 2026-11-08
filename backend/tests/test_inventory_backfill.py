"""Planner and report tests for moving inventory_items rows into foods and lots.

The tests pass plain rows in and check the plan and report. No database runs.
"""

from __future__ import annotations

import json
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path
from uuid import UUID, uuid4

import pytest

from app.inventory.backfill import (
    CookRef,
    HouseholdPlan,
    InventoryRow,
    ParsedUnit,
    StockShape,
    Unparsed,
    parse_unit,
    plan_backfill,
)
from app.scripts.dry_run_inventory_backfill import render

HOUSEHOLD = UUID("11111111-1111-1111-1111-111111111111")
OTHER_HOUSEHOLD = UUID("22222222-2222-2222-2222-222222222222")
START = datetime(2026, 11, 1, 12, tzinfo=timezone.utc)
TODAY = date(2026, 11, 7)
GRAMS = StockShape("g", None)
MILLILITRES = StockShape("ml", None)
# Shared with mobile/lib/__tests__/stockUnit.test.ts, so the add form reads table
# units and bare words the way the backfill did and adds land on the moved
# food. Package forms ("Containers (63 g each)") are read only here.
STOCK_UNIT_CASES = json.loads(
    (Path(__file__).parent / "fixtures/stock_unit_cases.json").read_text()
)


def row(
    name: str, quantity: str, unit: str, minute: int = 0, **overrides
) -> InventoryRow:
    """Build an inventory row created ``minute`` minutes after ``START``.

    ``clean_name`` and ``name_key`` stand in for the SQL the CLI reads them
    with. The test names use only ASCII spaces, where Python and Postgres agree.
    """
    created = START + timedelta(minutes=minute)
    clean = " ".join(name.split())
    fields = {
        "id": uuid4(),
        "household_id": HOUSEHOLD,
        "name": name,
        "clean_name": clean,
        "name_key": clean.lower(),
        "quantity": Decimal(quantity),
        "unit": unit,
        "expiration_date": None,
        "storage_location": "fridge",
        "category_id": None,
        "notes": "",
        "added_by": None,
        "created_at": created,
        "updated_at": created,
        "depleted_at": None,
    }
    return InventoryRow(**{**fields, **overrides})


def only_household(rows, cook_refs=()) -> HouseholdPlan:
    (household,) = plan_backfill(rows, cook_refs).households
    return household


@pytest.mark.parametrize(
    ("unit", "shape", "per_unit", "guess_mentions"),
    [
        ("g", GRAMS, "1", None),
        ("G", GRAMS, "1", None),
        ("kg", GRAMS, "1000", None),
        ("oz", GRAMS, "28.349523125", "weight ounces (28.35 g)"),
        ("lb", GRAMS, "453.59237", None),
        ("l", MILLILITRES, "1000", None),
        ("ml", MILLILITRES, "1", None),
        ("Cups", MILLILITRES, "236.5882365", "US cups (236.59 ml)"),
        ("item", StockShape("each", "each"), "1", "generic each"),
        ("head", StockShape("each", "head"), "1", None),
        ("can", StockShape("each", "can"), "1", None),
        ("loaf", StockShape("each", "loaf"), "1", None),
        ("Slices", StockShape("each", "slice"), "1", None),
        ("Tostadas", StockShape("each", "tostada"), "1", None),
        ("servings", StockShape("each", "serving"), "1", None),
        ("Large Cups", StockShape("each", "large cup"), "1", None),
        (
            "Container (14 servings)",
            StockShape(
                "each",
                "container",
                household_units=(("serving", Decimal(1) / Decimal(14)),),
            ),
            "1",
            "1 serving = 1/14 container",
        ),
        (
            "Containers (63 g each)",
            StockShape("each", "container", grams_per_each=Decimal(63)),
            "1",
            None,
        ),
        (
            "Bowls (210 grams each)",
            StockShape("each", "bowl", grams_per_each=Decimal(210)),
            "1",
            None,
        ),
        (
            "Bottles (2 fl oz each)",
            StockShape("each", "bottle", ml_per_each=Decimal("59.1470591250")),
            "1",
            None,
        ),
        (
            "Jar (300 g)",
            StockShape("each", "jar", grams_per_each=Decimal(300)),
            "1",
            "read as 300 g each",
        ),
    ],
)
def test_parse_unit_reads_every_unit_in_use(unit, shape, per_unit, guess_mentions):
    parsed = parse_unit(unit)

    assert isinstance(parsed, ParsedUnit)
    assert parsed.shape == shape
    assert parsed.per_unit == Decimal(per_unit)
    if guess_mentions is None:
        assert parsed.guess is None
    else:
        assert guess_mentions in parsed.guess


@pytest.mark.parametrize(
    "unit",
    [
        "",
        "   ",
        "1 kg",
        "x-y",
        "Box (0 g each)",
        "Pack (2 packs)",
        "Jar (3 ?)",
        "Tub (4 scoops each)",
    ],
)
def test_parse_unit_rejects_text_no_rule_reads(unit):
    assert isinstance(parse_unit(unit), Unparsed)


@pytest.mark.parametrize(
    "build",
    [
        lambda: StockShape("each", None),
        lambda: StockShape("g", "container"),
        lambda: StockShape("each", "jar", grams_per_each=Decimal(0)),
        lambda: StockShape("each", "jar", household_units=(("scoop", Decimal(-1)),)),
    ],
)
def test_stock_shapes_that_break_food_rules_cannot_be_built(build):
    with pytest.raises(ValueError):
        build()


def test_stock_shapes_are_hashable_values():
    def build() -> StockShape:
        return StockShape(
            "each", "container", household_units=(("serving", Decimal(1) / 14),)
        )

    assert len({build(), build()}) == 1


def test_rows_of_one_food_become_one_food_with_a_lot_per_row_keeping_ids():
    eggs = [
        row("Eggs", "6", "item", minute=0),
        row("Eggs", "12", "item", minute=1),
        row("Eggs", "3", "item", minute=2),
    ]

    household = only_household(eggs)

    (food,) = household.foods
    assert food.name == "Eggs"
    assert food.shape == StockShape("each", "each")
    assert [lot.id for lot in food.lots] == [r.id for r in eggs]
    assert [lot.quantity for lot in food.lots] == [Decimal(6), Decimal(12), Decimal(3)]
    assert household.skipped == ()
    assert [g.row_id for g in household.guesses] == [r.id for r in eggs]


def test_name_variants_group_into_one_food_named_after_the_newest_row():
    older = row(" milk ", "1", "l", minute=0)
    newer = row("Milk", "500", "ml", minute=1)

    household = only_household([older, newer])

    (food,) = household.foods
    assert (food.name, food.name_key) == ("Milk", "milk")
    assert [lot.quantity for lot in food.lots] == [Decimal(1000), Decimal(500)]
    assert [g.row_id for g in household.guesses] == [None]


def test_category_comes_from_the_newest_row_that_has_one_and_is_a_guess():
    produce, dairy = uuid4(), uuid4()

    household = only_household(
        [
            row("Cheese", "1", "kg", minute=0, category_id=produce),
            row("Cheese", "2", "kg", minute=1, category_id=dairy),
            row("Cheese", "3", "kg", minute=2),
        ]
    )

    assert household.foods[0].category_id == dairy
    assert [g.row_id for g in household.guesses] == [None]


def test_each_household_gets_its_own_plan():
    plan = plan_backfill(
        [row("Rice", "1", "kg", household_id=OTHER_HOUSEHOLD), row("Rice", "1", "kg")]
    )

    assert [h.household_id for h in plan.households] == [HOUSEHOLD, OTHER_HOUSEHOLD]
    assert [len(h.foods) for h in plan.households] == [1, 1]


def test_rows_in_another_stock_base_are_skipped_not_converted():
    grams_1 = row("Rice", "500", "g", minute=0)
    cups = row("Rice", "2", "Cups", minute=1)
    grams_2 = row("rice", "1", "kg", minute=2)

    household = only_household([grams_1, cups, grams_2])

    (food,) = household.foods
    assert food.shape == GRAMS
    assert [lot.id for lot in food.lots] == [grams_1.id, grams_2.id]
    (skip,) = household.skipped
    assert skip.row == cups
    assert "millilitres" in skip.reason and "grams" in skip.reason


def test_a_stock_base_tie_goes_to_the_earliest_row():
    cups = row("Flour", "2", "Cups", minute=0)
    grams = row("Flour", "500", "g", minute=1)

    household = only_household([grams, cups])

    assert household.foods[0].shape == MILLILITRES
    assert [s.row for s in household.skipped] == [grams]


def test_live_stock_outvotes_used_up_rows_in_another_unit():
    used_at = START + timedelta(days=1)
    empty_cups = row("Rice", "0", "Cups", minute=0)
    used_cups = row("Rice", "2", "Cups", minute=1, depleted_at=used_at)
    live_grams = row("Rice", "900", "g", minute=2)

    household = only_household([empty_cups, used_cups, live_grams])

    (food,) = household.foods
    assert food.shape == GRAMS
    assert [lot.id for lot in food.lots] == [live_grams.id]
    assert [s.row for s in household.skipped] == [empty_cups, used_cups]


def test_used_up_rows_vote_when_no_row_is_live():
    zero_cups = row("Rice", "0", "Cups", minute=0)
    zero_grams = row("Rice", "0", "g", minute=1)
    zero_grams_2 = row("Rice", "0", "g", minute=2)

    household = only_household([zero_cups, zero_grams, zero_grams_2])

    assert household.foods[0].shape == GRAMS
    assert [s.row for s in household.skipped] == [zero_cups]


def test_rows_that_differ_only_in_stated_sizes_share_one_food():
    servings = row("Soup", "2", "Container (14 servings)", minute=0)
    plain = row("Soup", "1", "Container", minute=1)

    household = only_household([servings, plain])

    (food,) = household.foods
    assert food.shape == StockShape(
        "each", "container", household_units=(("serving", Decimal(1) / 14),)
    )
    assert [lot.id for lot in food.lots] == [servings.id, plain.id]
    assert household.skipped == ()


def test_a_size_the_rows_disagree_on_comes_from_the_newest_live_row():
    live_63 = row("Yogurt", "2", "Containers (63 g each)", minute=0)
    live_70 = row("Yogurt", "1", "Containers (70 g each)", minute=1)
    used_80 = row("Yogurt", "1", "Containers (80 g each)", minute=2, depleted_at=START)

    household = only_household([live_63, live_70, used_80])

    (food,) = household.foods
    assert food.shape.grams_per_each == Decimal(70)
    assert len(food.lots) == 3
    (size_guess,) = [g for g in household.guesses if g.row_id is None]
    assert "63" in size_guess.message and "80" in size_guess.message


def test_zero_and_depleted_rows_become_used_lots_and_negative_rows_are_skipped():
    used_at = START + timedelta(days=2)
    zero = row("Butter", "0", "g", minute=0, updated_at=used_at)
    depleted = row("Butter", "40", "g", minute=1, depleted_at=used_at)
    negative = row("Butter", "-1", "g", minute=2)

    household = only_household([zero, depleted, negative])

    lots = {lot.id: lot for lot in household.foods[0].lots}
    assert (lots[zero.id].depleted_at, lots[zero.id].depleted_reason) == (
        used_at,
        "used",
    )
    assert (lots[depleted.id].depleted_at, lots[depleted.id].quantity) == (
        used_at,
        Decimal(40),
    )
    assert [g.row_id for g in household.guesses] == [zero.id, depleted.id]
    assert [s.row for s in household.skipped] == [negative]


def test_unparsable_units_and_bad_names_are_skipped_with_reasons():
    odd = row("Jam", "1", "2 jars?")
    blank = row("   ", "1", "g")
    long_name = row("x" * 81, "1", "g")
    longest = row("y" * 80, "1", "g")

    household = only_household([odd, blank, long_name, longest])

    assert [f.name for f in household.foods] == ["y" * 80]
    reasons = {s.row.id: s.reason for s in household.skipped}
    assert reasons.keys() == {odd.id, blank.id, long_name.id}
    assert "2 jars?" in reasons[odd.id]


def test_lots_keep_source_fields_and_blank_notes_become_null():
    added_by = uuid4()
    kept = row(
        "Yogurt",
        "2",
        "Containers (63 g each)",
        expiration_date=date(2026, 11, 20),
        storage_location="freezer",
        notes="  ",
        added_by=added_by,
    )

    (lot,) = only_household([kept]).foods[0].lots

    assert lot.quantity == Decimal(2)
    assert (lot.source_quantity, lot.source_unit) == (
        Decimal(2),
        "Containers (63 g each)",
    )
    assert (lot.expiration_date, lot.storage_location) == (
        date(2026, 11, 20),
        "freezer",
    )
    assert (lot.notes, lot.added_by, lot.created_at) == (
        None,
        added_by,
        kept.created_at,
    )
    assert lot.depleted_at is None and lot.depleted_reason is None


def test_cook_refs_to_skipped_or_missing_rows_are_unresolved():
    kept = row("Garlic", "2", "head")
    skipped = row("Garlic", "-1", "head")
    deleted = uuid4()
    refs = [CookRef(HOUSEHOLD, i) for i in (kept.id, skipped.id, deleted, kept.id)]

    household = only_household([kept, skipped], refs)

    assert household.unresolved_cook_refs == tuple(sorted([skipped.id, deleted]))
    assert len(household.cooked_item_ids) == 3


def test_a_household_with_only_cook_refs_still_reports_them():
    missing = uuid4()

    household = only_household([], [CookRef(OTHER_HOUSEHOLD, missing)])

    assert household.household_id == OTHER_HOUSEHOLD
    assert household.unresolved_cook_refs == (missing,)


def test_render_reports_foods_lots_guesses_skips_and_cook_check():
    yogurt = row(
        "Yogurt",
        "2",
        "Containers (63 g each)",
        expiration_date=date(2026, 11, 1),
    )
    soup = row("Soup", "1.5", "Container (14 servings)", storage_location="pantry")
    milk = row("Milk", "0", "Cups")
    odd = row("Jam", "1", "2 jars?")
    plan = plan_backfill([yogurt, soup, milk, odd], [CookRef(HOUSEHOLD, yogurt.id)])

    report = render(plan, TODAY)

    assert "initial (full) amount is left unknown (null)" in report
    assert (
        f"Household {HOUSEHOLD}: 4 rows, 3 foods, 3 lots, 3 guesses, 1 skipped"
        in report
    )
    assert "Yogurt: counted in container, 63 g each" in report
    assert (
        f"lot {yogurt.id}  2 container  from 2 Containers (63 g each)  "
        "expires 2026-11-01 (expired)  fridge" in report
    )
    assert "Soup: counted in container; 1 serving = 1/14 container" in report
    assert f"lot {soup.id}  1.5 container  from 1.5 Container (14 servings)" in report
    assert (
        f"lot {milk.id}  0 ml  from 0 Cups  no expiry  fridge  depleted (used)"
        in report
    )
    assert f"row {odd.id} 'Jam'" in report
    assert "Cook events: all 1 cooked item ids resolve to lots." in report


def test_render_prints_none_for_empty_sections_and_lists_unresolved_ids():
    kept = row("Salt", "1", "kg")
    missing = uuid4()

    report = render(plan_backfill([kept], [CookRef(HOUSEHOLD, missing)]), TODAY)

    assert report.count("    none") == 2
    assert f"resolve to no lot: {missing}" in report


def test_render_says_so_when_there_is_nothing_to_plan():
    assert "No inventory rows." in render(plan_backfill([]), TODAY)


@pytest.mark.parametrize("case", STOCK_UNIT_CASES, ids=lambda c: c["unit"])
def test_parse_unit_matches_the_shared_add_form_cases(case):
    parsed = parse_unit(case["unit"])

    assert isinstance(parsed, ParsedUnit)
    assert parsed.shape.stock_base == case["stock_base"]
    assert parsed.shape.each_label == case["each_label"]
    assert parsed.per_unit == Decimal(case["per_unit"])
