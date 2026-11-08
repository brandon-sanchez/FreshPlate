"""Reading public.food_facts rows into converter input."""

from __future__ import annotations

from decimal import Decimal

import pytest

from app.inventory.food_facts import food_facts_from_row
from app.inventory.units import Approximate, to_stock

D = Decimal


def rice_row(**changes):
    row = {
        "stock_base": "g",
        "each_label": None,
        "grams_per_each": None,
        "ml_per_each": None,
        "g_per_ml": None,
        "household_units": {},
        "profile_key": "rice",
        "profile_g_per_ml": 0.782,
        "profile_unit_grams": {"cup": 185.0},
    }
    return {**row, **changes}


def test_one_cup_of_basmati_rice_stocked_in_grams_is_approximate():
    assert to_stock(D(1), "cup", food_facts_from_row(rice_row())) == Approximate(
        D("185.0")
    )


def test_a_row_without_a_profile_key_has_no_profile():
    row = rice_row(profile_key=None, profile_g_per_ml=None, profile_unit_grams=None)
    assert food_facts_from_row(row).profile is None


@pytest.mark.parametrize(
    "changes",
    [
        {"g_per_ml": "dense"},
        {"g_per_ml": "NaN"},
        {"g_per_ml": float("inf")},
        {"grams_per_each": 0},
        {"household_units": {"scoop": -2}},
        {"profile_g_per_ml": "?"},
        {"profile_unit_grams": {"cup": "Infinity"}},
    ],
)
def test_non_numeric_or_non_positive_facts_raise_value_error(changes):
    with pytest.raises(ValueError):
        food_facts_from_row(rice_row(**changes))
