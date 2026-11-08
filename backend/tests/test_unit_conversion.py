from __future__ import annotations

from decimal import Decimal

import pytest

from app.inventory.units import (
    Approximate,
    AskAtCook,
    Exact,
    FoodFacts,
    ProfileFacts,
    Small,
    normalize_unit,
    table_unit,
    to_stock,
)

D = Decimal
GARLIC_PROFILE = ProfileFacts(unit_grams={"Cloves": D(3), "head": D(40)})
GARLIC = FoodFacts(stock_base="each", each_label="head", profile=GARLIC_PROFILE)
OIL = FoodFacts(stock_base="ml")
BUTTER = FoodFacts(stock_base="g")
MILK = FoodFacts(stock_base="ml")
ONIONS = FoodFacts(stock_base="g", grams_per_each=D(150))
SALT = FoodFacts(stock_base="each", each_label="container")
COLA = FoodFacts(stock_base="each", each_label="can", ml_per_each=D(355))


def _approx(conversion: Exact | Approximate | Small, places: str = "0.001") -> D:
    return conversion.amount.quantize(D(places))


@pytest.mark.parametrize(
    ("text", "key"),
    [
        ("Cups", "cup"),
        ("tbsp.", "tbsp"),
        ("Tablespoons", "tbsp"),
        ("tbs", "tbsp"),
        ("fl. oz.", "fl oz"),
        ("Fluid Ounces", "fl oz"),
        ("kgs", "kg"),
        ("mls", "ml"),
        ("lbs", "lb"),
        ("Lb", "lb"),
        ("  Heads ", "head"),
        ("bulb", "head"),
        ("Pieces", "each"),
        ("", "each"),
        ("a pinch", "pinch"),
        ("Tomatoes", "tomato"),
        ("bay leaves", "bay leaf"),
        ("Loaves", "loaf"),
        ("cookies", "cookie"),
        ("pcs", "each"),
    ],
)
def test_normalize_unit(text, key) -> None:
    assert normalize_unit(text) == key


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("G", ("g", D(1))),
        ("kgs", ("g", D(1000))),
        ("oz", ("g", D("28.349523125"))),
        ("fl. oz.", ("ml", D("29.5735295625"))),
        ("Cups", ("ml", D("236.5882365"))),
        ("l", ("ml", D(1000))),
        ("large cup", None),
        ("slices", None),
        ("item", None),
    ],
)
def test_table_unit_finds_only_mass_and_volume_units(text, expected) -> None:
    assert table_unit(text) == expected


def test_garlic_cloves_become_about_a_fraction_of_a_head() -> None:
    result = to_stock(D(3), "cloves", GARLIC)
    assert isinstance(result, Approximate)
    assert _approx(result) == D("0.225")


def test_household_clove_factor_beats_the_profile() -> None:
    garlic = FoodFacts(
        stock_base="each",
        each_label="head",
        household_units={"clove": D("0.1")},
        profile=GARLIC_PROFILE,
    )
    assert to_stock(D(3), "Cloves", garlic) == Exact(D("0.3"))


def test_household_head_weight_beats_the_profile_head_weight() -> None:
    garlic = FoodFacts(
        stock_base="each",
        each_label="head",
        grams_per_each=D(60),
        profile=GARLIC_PROFILE,
    )
    result = to_stock(D(3), "clove", garlic)
    assert isinstance(result, Approximate)
    assert _approx(result) == D("0.150")


@pytest.mark.parametrize("unit", ["head", "Heads", "bulbs", "each", ""])
def test_the_each_label_and_its_synonyms_count_whole_units(unit) -> None:
    assert to_stock(D(2), unit, GARLIC) == Exact(D(2))


@pytest.mark.parametrize(
    ("amount", "unit", "food", "expected"),
    [
        (D(2), "tbsp", OIL, "29.574"),
        (D(8), "oz", BUTTER, "226.796"),
        (D(8), "oz", MILK, "236.588"),
        (D(1), "lb", BUTTER, "453.592"),
        (D("0.5"), "l", MILK, "500.000"),
        (D(250), "mg", BUTTER, "0.250"),
        (D(1), "qt", MILK, "946.353"),
    ],
)
def test_same_dimension_units_convert_exactly(amount, unit, food, expected) -> None:
    result = to_stock(amount, unit, food)
    assert isinstance(result, Exact)
    assert _approx(result) == D(expected)


def test_a_profile_weight_for_a_table_unit_does_not_replace_the_table() -> None:
    oil = FoodFacts(
        stock_base="ml",
        profile=ProfileFacts(g_per_ml=D("0.92"), unit_grams={"tbsp": D("13.6")}),
    )
    result = to_stock(D(2), "tbsp", oil)
    assert isinstance(result, Exact)
    assert _approx(result) == D("29.574")


def test_a_profile_cup_weight_still_beats_a_density_estimate() -> None:
    rice = FoodFacts(
        stock_base="g",
        profile=ProfileFacts(g_per_ml=D("0.85"), unit_grams={"cup": D(185)}),
    )
    assert to_stock(D(1), "cup", rice) == Approximate(D(185))


def test_fluid_ounces_against_a_weighed_food_need_a_density() -> None:
    assert to_stock(D(1), "fl oz", BUTTER) == AskAtCook("needs_density")


@pytest.mark.parametrize("unit", ["", "each", "large", "whole", "Pieces"])
def test_counted_onions_convert_to_grams(unit) -> None:
    assert to_stock(D(2), unit, ONIONS) == Exact(D(300))


def test_counted_onions_without_a_size_ask_at_cook() -> None:
    onions = FoodFacts(stock_base="g")
    assert to_stock(D(2), "large", onions) == AskAtCook("needs_each_size")


def test_counted_food_uses_the_profile_each_weight_as_an_estimate() -> None:
    onions = FoodFacts(
        stock_base="g", profile=ProfileFacts(unit_grams={"each": D(110)})
    )
    result = to_stock(D(2), "", onions)
    assert isinstance(result, Approximate)
    assert result.amount == D(220)


def test_a_profile_size_word_is_tried_before_the_size_is_stripped() -> None:
    onions = FoodFacts(
        stock_base="g",
        grams_per_each=D(150),
        profile=ProfileFacts(unit_grams={"medium": D(110)}),
    )
    assert to_stock(D(1), "Medium", onions) == Approximate(D(110))
    assert to_stock(D(1), "large", onions) == Exact(D(150))


def test_size_words_drop_from_measured_units() -> None:
    assert to_stock(D(1), "heaping tablespoon", OIL) == to_stock(D(1), "tbsp", OIL)


def test_a_cup_of_rice_uses_the_profile_density_as_an_estimate() -> None:
    rice = FoodFacts(stock_base="g", profile=ProfileFacts(g_per_ml=D("0.85")))
    result = to_stock(D(1), "cup", rice)
    assert isinstance(result, Approximate)
    assert _approx(result) == D("201.100")


def test_the_household_density_is_exact() -> None:
    honey = FoodFacts(stock_base="g", g_per_ml=D("1.42"))
    result = to_stock(D(1), "tbsp", honey)
    assert isinstance(result, Exact)
    assert _approx(result) == D("20.997")


def test_a_teaspoon_from_a_container_of_unknown_size_is_small() -> None:
    result = to_stock(D(1), "tsp", SALT)
    assert isinstance(result, Small)
    assert result.unit == "ml"
    assert _approx(result) == D("4.929")


def test_grams_from_a_container_of_unknown_size_are_small() -> None:
    assert to_stock(D(15), "g", SALT) == Small(D(15), "g")


def test_half_a_cup_from_a_container_of_unknown_size_asks_for_its_size() -> None:
    assert to_stock(D("0.5"), "cup", SALT) == AskAtCook("needs_package_size")


def test_a_sized_package_without_a_density_path_asks_for_a_density() -> None:
    assert to_stock(D(100), "g", COLA) == AskAtCook("needs_density")


def test_a_small_draw_in_a_package_s_unknown_dimension_is_small() -> None:
    assert to_stock(D(5), "g", COLA) == Small(D(5), "g")


def test_millilitres_of_cola_become_a_fraction_of_cans_without_rounding() -> None:
    result = to_stock(D(500), "ml", COLA)
    assert isinstance(result, Exact)
    assert _approx(result) == D("1.408")


def test_harissa_by_the_tablespoon_without_facts_asks_for_a_density() -> None:
    harissa = FoodFacts(stock_base="g")
    assert to_stock(D(1), "tbsp", harissa) == AskAtCook("needs_density")


@pytest.mark.parametrize(
    ("amount", "unit", "expected"),
    [
        (D(1), "pinch", "0.308"),
        (D(2), "a pinch", "0.616"),
        (D(1), "Dashes", "0.616"),
        (D(1), "to taste", "0.000"),
    ],
)
@pytest.mark.parametrize("food", [BUTTER, OIL, GARLIC, SALT])
def test_seasoning_words_are_small_for_any_food(amount, unit, expected, food) -> None:
    result = to_stock(amount, unit, food)
    assert isinstance(result, Small)
    assert result.unit == "ml"
    assert _approx(result) == D(expected)


def test_an_unknown_word_asks_at_cook() -> None:
    bread = FoodFacts(stock_base="g")
    assert to_stock(D(2), "slices", bread) == AskAtCook("unknown_unit")


@pytest.mark.parametrize("amount", [D(0), D(-1), D("NaN"), D("sNaN"), D("Infinity")])
def test_invalid_amounts_ask_at_cook(amount) -> None:
    assert to_stock(amount, "g", BUTTER) == AskAtCook("invalid_amount")


@pytest.mark.parametrize("amount", [D(0), D(1)])
def test_to_taste_is_small_whatever_amount_the_recipe_sends(amount) -> None:
    assert to_stock(amount, "To taste", SALT) == Small(D(0), "ml")


@pytest.mark.parametrize(
    "build",
    [
        lambda: FoodFacts(stock_base="each"),
        lambda: FoodFacts(stock_base="g", each_label="head"),
        lambda: FoodFacts(stock_base="g", grams_per_each=D(0)),
        lambda: FoodFacts(stock_base="ml", household_units={"glass": D("NaN")}),
        lambda: ProfileFacts(unit_grams={"clove": D(-3)}),
        lambda: ProfileFacts(unit_grams={"Cloves": D(3), "clove": D(4)}),
    ],
)
def test_malformed_food_facts_are_rejected_when_built(build) -> None:
    with pytest.raises(ValueError):
        build()
