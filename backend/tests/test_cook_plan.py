from __future__ import annotations

from dataclasses import replace
from decimal import Decimal
from uuid import UUID, uuid4

import pytest

from app.inventory.cook_plan import (
    CookLine,
    FoodPlan,
    FoodStock,
    LineAsk,
    SmallTotal,
    plan_cook,
)
from app.inventory.units import FoodFacts, ProfileFacts

D = Decimal
PLENTY = D(1000)
OIL = FoodFacts(stock_base="ml")
HARISSA = FoodFacts(stock_base="g")
SALT = FoodFacts(stock_base="each", each_label="container")
COLA = FoodFacts(stock_base="each", each_label="can", ml_per_each=D(355))
WHOLE_COLA = replace(COLA, whole_units_only=True)
EGGS = FoodFacts(stock_base="each", each_label="egg", whole_units_only=True)
CARTON_EGGS = FoodFacts(
    stock_base="each",
    each_label="carton",
    whole_units_only=True,
    profile=ProfileFacts(unit_grams={"each": D(50), "egg": D(50)}),
)
GARLIC = FoodFacts(
    stock_base="each",
    each_label="head",
    profile=ProfileFacts(unit_grams={"clove": D(3), "head": D(40)}),
)


def _plan(
    *lines: tuple[FoodFacts, str, str], available: Decimal = PLENTY
) -> list[FoodPlan]:
    ids: dict[int, UUID] = {}
    stock: dict[UUID, FoodStock] = {}
    cook_lines = []
    for facts, amount, unit in lines:
        food_id = ids.setdefault(id(facts), uuid4())
        stock[food_id] = FoodStock(facts, available=available)
        cook_lines.append(CookLine(food_id, D(amount), unit))
    return list(plan_cook(cook_lines, stock).foods)


def _rounded(small: SmallTotal | None) -> tuple[Decimal, str]:
    assert small is not None
    return small.amount.quantize(D("0.001")), small.unit


def test_lines_of_one_food_sum_into_one_plan() -> None:
    [oil] = _plan((OIL, "1", "tbsp"), (OIL, "1", "tsp"))
    assert oil.lines == (0, 1)
    assert oil.draw == D("19.7")
    assert oil.stock_base == "ml"
    assert not oil.estimated
    assert oil.small is None and oil.asks == () and oil.rounding is None


def test_the_sum_is_rounded_once_not_per_line() -> None:
    [oil] = _plan((OIL, "1", "tsp"), (OIL, "1", "tsp"), (OIL, "1", "tsp"))
    assert oil.draw == D("14.8")


def test_seasoning_used_twice_is_one_small_plan() -> None:
    [salt] = _plan((SALT, "1", "tsp"), (SALT, "1", "pinch"))
    assert salt.lines == (0, 1)
    assert _rounded(salt.small) == (D("5.237"), "ml")
    assert salt.draw == 0 and salt.asks == ()


def test_grams_and_millilitres_sum_against_one_small_limit() -> None:
    [salt] = _plan((SALT, "1", "tsp"), (SALT, "5", "g"))
    assert _rounded(salt.small) == (D("9.929"), "ml")
    assert salt.asks == ()


def test_exactly_the_small_limit_stays_small() -> None:
    [salt] = _plan((SALT, "15", "g"), (SALT, "0", "to taste"))
    assert salt.small == SmallTotal(D(15), "g")
    assert salt.asks == ()


def test_just_over_the_small_limit_asks_for_every_small_line() -> None:
    [salt] = _plan((SALT, "15", "g"), (SALT, "1", "pinch"))
    assert salt.small is None
    assert salt.asks == (
        LineAsk(0, D(15), "g", "needs_package_size"),
        LineAsk(1, D(1), "pinch", "needs_package_size"),
    )


def test_small_lines_that_only_pass_alone_ask_for_the_package_size() -> None:
    lines = [(SALT, "1", "tbsp")] * 3
    [alone] = _plan(lines[0])
    assert alone.small is not None
    [salt] = _plan(*lines)
    assert salt.small is None
    assert [ask.line for ask in salt.asks] == [0, 1, 2]
    assert {ask.reason for ask in salt.asks} == {"needs_package_size"}


def test_a_pinch_beside_grams_from_an_unknown_container_asks_for_both() -> None:
    [salt] = _plan((SALT, "1", "pinch"), (SALT, "20", "g"))
    assert salt.small is None
    assert salt.asks == (
        LineAsk(0, D(1), "pinch", "needs_package_size"),
        LineAsk(1, D(20), "g", "needs_package_size"),
    )


@pytest.mark.parametrize(
    "amounts", [("20",), ("10", "10"), ("10", "20")], ids=["20", "10+10", "10+20"]
)
def test_grams_of_a_package_sized_in_ml_ask_for_a_density(amounts) -> None:
    [cola] = _plan(*[(COLA, amount, "g") for amount in amounts])
    assert cola.small is None
    assert [ask.reason for ask in cola.asks] == ["needs_density"] * len(amounts)


def test_many_dashes_on_a_measured_food_are_drawn() -> None:
    [oil] = _plan((OIL, "50", "dash"))
    assert oil.small is None
    assert oil.draw == D("30.8")


def test_many_dashes_on_a_package_sized_in_ml_draw_from_it() -> None:
    [cola] = _plan((COLA, "50", "dash"))
    assert cola.small is None and cola.asks == ()
    assert cola.draw == D("0.087")


def test_many_dashes_without_a_conversion_ask_with_its_reason() -> None:
    [harissa] = _plan((HARISSA, "50", "dash"))
    assert harissa.small is None
    assert harissa.asks == (LineAsk(0, D(50), "dash", "needs_density"),)


def test_whole_units_round_up_with_a_note() -> None:
    [cola] = _plan((WHOLE_COLA, "500", "ml"))
    assert cola.draw == 2
    assert cola.rounding is not None
    assert cola.rounding.needs == D(500) / D(355)
    assert cola.rounding.note == "Uses 2 cans, recipe needs about 1.4"


def test_whole_units_already_whole_need_no_note() -> None:
    [eggs] = _plan((EGGS, "3", "eggs"))
    assert eggs.draw == 3
    assert eggs.rounding is None


def test_whole_unit_note_uses_the_singular_for_one() -> None:
    [eggs] = _plan((EGGS, "0.5", "egg"))
    assert eggs.draw == 1
    assert eggs.rounding is not None
    assert eggs.rounding.note == "Uses 1 egg, recipe needs about 0.5"


@pytest.mark.parametrize(
    ("label", "note"),
    [
        ("box", "Uses 2 boxes, recipe needs about 1.5"),
        ("loaf", "Uses 2 loaves, recipe needs about 1.5"),
        ("leaf", "Uses 2 leaves, recipe needs about 1.5"),
        ("half", "Uses 2 halves, recipe needs about 1.5"),
        ("each", "Uses 2, recipe needs about 1.5"),
        ("piece", "Uses 2, recipe needs about 1.5"),
        ("item", "Uses 2, recipe needs about 1.5"),
    ],
)
def test_whole_unit_note_pluralizes_the_label(label, note) -> None:
    food = FoodFacts(
        stock_base="each",
        each_label=label,
        whole_units_only=True,
        grams_per_each=D(100),
    )
    [plan] = _plan((food, "150", "g"))
    assert plan.rounding is not None
    assert plan.rounding.note == note


def test_whole_unit_note_never_shows_a_zero_need() -> None:
    [cola] = _plan((WHOLE_COLA, "1", "tsp"))
    assert cola.draw == 1
    assert cola.rounding is not None
    assert cola.rounding.note == "Uses 1 can, recipe needs about 0.01"


def test_whole_unit_note_never_shows_a_whole_need() -> None:
    boxes = FoodFacts(
        stock_base="each",
        each_label="box",
        whole_units_only=True,
        grams_per_each=D(100),
    )
    [box] = _plan((boxes, "190", "g"))
    assert box.rounding is not None
    assert box.rounding.note == "Uses 2 boxes, recipe needs about 1.9"
    [box] = _plan((boxes, "101", "g"))
    assert box.rounding is not None
    assert box.rounding.note == "Uses 2 boxes, recipe needs about 1.01"
    [box] = _plan((boxes, "199.6", "g"))
    assert box.rounding is not None
    assert box.rounding.note == "Uses 2 boxes, recipe needs about 1.996"


def test_an_exact_whole_need_through_division_does_not_round_up() -> None:
    # 200 ml at 3 g/ml is 600 g, six 100 g tins, but the tin size in ml is
    # 100/3, so the converted need computes as 6.000...001.
    tins = FoodFacts(
        stock_base="each",
        each_label="tin",
        whole_units_only=True,
        grams_per_each=D(100),
        g_per_ml=D(3),
    )
    [tin] = _plan((tins, "200", "ml"))
    assert tin.draw == 6
    assert tin.rounding is None


def test_profile_estimates_mark_the_plan_estimated() -> None:
    [garlic] = _plan((GARLIC, "3", "cloves"))
    assert garlic.estimated
    assert garlic.draw == D("0.225")


def test_ask_lines_are_reported_beside_other_foods() -> None:
    oil, harissa = _plan(
        (OIL, "2", "tbsp"), (HARISSA, "1", "tbsp"), (HARISSA, "1", "handful")
    )
    assert oil.draw == D("29.6") and oil.asks == ()
    assert harissa.lines == (1, 2)
    assert harissa.draw == 0
    assert harissa.asks == (
        LineAsk(1, D(1), "tbsp", "needs_density"),
        LineAsk(2, D(1), "handful", "unknown_unit"),
    )


def test_shortfall_is_the_draw_stock_does_not_cover() -> None:
    [oil] = _plan((OIL, "2", "tbsp"), available=D(10))
    assert oil.shortfall == D("19.6")
    [oil] = _plan((OIL, "2", "tbsp"), available=D(30))
    assert oil.shortfall == 0


def test_foods_are_ordered_by_first_appearance() -> None:
    plans = _plan((HARISSA, "10", "g"), (OIL, "1", "tbsp"), (HARISSA, "5", "g"))
    assert [plan.lines for plan in plans] == [(0, 2), (1,)]
    assert [plan.draw for plan in plans] == [D(15), D("14.8")]


def test_a_line_for_a_food_without_stock_raises() -> None:
    missing = uuid4()
    with pytest.raises(ValueError, match=str(missing)):
        plan_cook([CookLine(missing, D(1), "g")], {})


@pytest.mark.parametrize("available", [D(-1), D("NaN"), D("Infinity")])
def test_available_must_be_finite_and_not_negative(available: Decimal) -> None:
    with pytest.raises(ValueError, match="available"):
        FoodStock(OIL, available=available)


@pytest.mark.xfail(strict=True, reason="a profile item weight sizes the package")
@pytest.mark.parametrize("unit", ["eggs", "large", "whole"])
def test_two_eggs_from_eggs_counted_in_cartons_ask_instead_of_taking_two_cartons(
    unit,
) -> None:
    [eggs] = _plan((CARTON_EGGS, "2", unit), available=D(2))
    assert eggs.draw == 0
    assert eggs.small is None
    assert eggs.asks == (LineAsk(0, D(2), unit, "needs_package_size"),)
