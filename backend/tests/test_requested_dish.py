from typing import get_args

import pytest

from app.ai.agents.dish import RequestedDish, requested_dish
from app.ai.agents.diversity import recipe_directions


@pytest.mark.parametrize(
    ("occasion", "dish"),
    [
        ("An after-school snack", "snack"),
        ("A snack, no nuts", "snack"),
        ("Dessert for two", "dessert"),
        ("Something sweet after the movie", "dessert"),
        ("Dinner and dessert", "meal"),
        ("Dessert wine pairing dinner", "meal"),
        ("Dinner (no snack), then dessert", "meal"),
        ("Dinner, no snacks or dessert", "meal"),
        ("No snack or dessert please", "meal"),
        ("Skip dessert", "meal"),
        ("I do not want dessert", "meal"),
        ("I don't want a snack", "meal"),
        ("Something dessert-free", "meal"),
        ("A no-dessert night", "meal"),
        ("Date night", "meal"),
    ],
)
def test_free_text_asks_for_a_snack_or_dessert_only_when_unambiguous(
    occasion: str, dish: str
) -> None:
    assert requested_dish({"occasion": occasion}) == dish


@pytest.mark.parametrize(
    ("meal", "dish"),
    [("Snack", "snack"), (" dessert ", "dessert"), ("Dinner", "meal")],
)
def test_the_which_meal_answer_decides_over_free_text(meal: str, dish: str) -> None:
    assert requested_dish({"meal": meal, "occasion": "Something sweet"}) == dish


@pytest.mark.parametrize("dish", get_args(RequestedDish))
def test_every_dish_has_directions(dish: RequestedDish) -> None:
    item = {
        "id": "f",
        "name": "Oats",
        "quantity": 1.0,
        "unit": "g",
        "units": ["g"],
        "lot_count": 1,
        "expiration_date": None,
        "days_until_expiration": None,
        "is_expiring": False,
        "food": {"category": "Grains & Bread"},
    }

    [direction] = recipe_directions([item], 1, dish=dish)

    assert f"into a real {dish}" in direction
