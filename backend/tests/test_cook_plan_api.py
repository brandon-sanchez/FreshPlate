# ruff: noqa: E501

from __future__ import annotations

from typing import Any
from uuid import UUID

import pytest
from fastapi.testclient import TestClient

from app.api.cook import get_cook_food_source
from app.main import create_app
from app.services.food_lines import FoodLinesError
from tests.conftest import HOUSEHOLD_ID, FakeFoodLineSource, SigningKey

OIL_ID = "00000000-0000-4000-8000-00000000000a"
EGGS_ID = "00000000-0000-4000-8000-00000000000b"
SALT_ID = "00000000-0000-4000-8000-00000000000c"
GARLIC_ID = "00000000-0000-4000-8000-00000000000d"
GONE_ID = "00000000-0000-4000-8000-00000000000e"

OIL = {"id": OIL_ID, "name": "Olive oil", "available": 500, "stock_base": "ml"}
EGGS = {"id": EGGS_ID, "name": "Eggs", "available": 4, "stock_base": "each", "each_label": "egg", "whole_units_only": True}
SALT = {"id": SALT_ID, "name": "Salt", "available": 1, "stock_base": "each", "each_label": "container"}
GARLIC = {
    "id": GARLIC_ID, "name": "Garlic", "available": 2, "stock_base": "each", "each_label": "head",
    "profile_key": "garlic", "profile_unit_grams": {"clove": 3, "head": 40},
}


def ingredient(name: str, food_id: str | None, amount: float | None, unit: str) -> dict[str, Any]:
    return {"name": name, "inventory_item_id": food_id, "use_amount": amount, "unit": unit}


class _FailingSource(FakeFoodLineSource):
    async def list_food_lines(self, household_id: Any) -> list[Any]:
        raise FoodLinesError("down")


@pytest.fixture
def kitchen(signing_key: SigningKey, patch_jwks):
    patch_jwks([signing_key])
    app = create_app()
    source = FakeFoodLineSource([OIL, EGGS, SALT, GARLIC])
    app.dependency_overrides[get_cook_food_source] = lambda: source
    return app, source, {"Authorization": f"Bearer {signing_key.sign()}"}


def post_plan(kitchen, *ingredients: dict[str, Any]):
    app, _, headers = kitchen
    return TestClient(app).post(
        "/api/cook/plan", headers=headers, json={"household_id": HOUSEHOLD_ID, "ingredients": list(ingredients)}
    )


def foods_of(response) -> dict[str, dict[str, Any]]:
    assert response.status_code == 200, response.text
    return {food["food_id"]: food for food in response.json()["data"]["foods"]}


def test_sums_a_foods_lines_and_reports_its_stock_and_each_line(kitchen):
    response = post_plan(
        kitchen,
        ingredient("Olive oil", OIL_ID, 2, "tbsp"),
        ingredient("Eggs", EGGS_ID, 2, "egg"),
        ingredient("Olive oil", OIL_ID, 1, "tsp"),
    )

    oil = foods_of(response)[OIL_ID]
    assert oil == {
        "food_id": OIL_ID, "name": "Olive oil", "stock_base": "ml", "each_label": None,
        "whole_units_only": False, "available": 500.0, "draw": 34.5, "estimated": False,
        "rounding_note": None,
        "lines": [
            {"line": 0, "ingredient": "Olive oil", "recipe_amount": 2.0, "recipe_unit": "tbsp", "mode": "draw", "stock_amount": 29.6},
            {"line": 2, "ingredient": "Olive oil", "recipe_amount": 1.0, "recipe_unit": "tsp", "mode": "draw", "stock_amount": 4.9},
        ],
    }
    assert [food["food_id"] for food in response.json()["data"]["foods"]] == [OIL_ID, EGGS_ID]
    assert kitchen[1].household_ids == [UUID(HOUSEHOLD_ID)]


def test_whole_unit_foods_round_up_and_say_so(kitchen):
    eggs = foods_of(post_plan(kitchen, ingredient("Eggs", EGGS_ID, 1.5, "egg")))[EGGS_ID]

    assert (eggs["draw"], eggs["rounding_note"]) == (2.0, "Uses 2 eggs, recipe needs about 1.5")
    assert eggs["lines"][0]["stock_amount"] == 1.5


def test_profile_estimates_mark_the_food_estimated(kitchen):
    garlic = foods_of(post_plan(kitchen, ingredient("Garlic", GARLIC_ID, 3, "clove")))[GARLIC_ID]

    assert (garlic["draw"], garlic["estimated"]) == (0.225, True)


def test_seasoning_amounts_are_small_and_unconvertible_amounts_ask(kitchen):
    salt = foods_of(post_plan(kitchen, ingredient("Salt", SALT_ID, 1, "pinch")))[SALT_ID]
    asked = foods_of(post_plan(kitchen, ingredient("Salt", SALT_ID, 100, "g")))[SALT_ID]

    assert (salt["draw"], salt["lines"][0]["mode"], salt["lines"][0]["stock_amount"]) == (0.0, "small", None)
    assert (asked["draw"], asked["lines"][0]["mode"], asked["lines"][0]["stock_amount"]) == (0.0, "ask", None)


def test_a_missing_amount_is_asked_about_and_recorded_as_zero(kitchen):
    oil = foods_of(post_plan(kitchen, ingredient("Olive oil", OIL_ID, None, "ml")))[OIL_ID]

    assert oil["lines"][0] == {
        "line": 0, "ingredient": "Olive oil", "recipe_amount": 0.0, "recipe_unit": "ml", "mode": "ask", "stock_amount": None,
    }


def test_kitchen_basics_and_foods_no_longer_in_stock_are_untracked(kitchen):
    response = post_plan(
        kitchen,
        ingredient("Salt", None, 1, "pinch"),
        ingredient("Eggs", EGGS_ID, 2, "egg"),
        ingredient("Butter", GONE_ID, 20, "g"),
    )

    assert list(foods_of(response)) == [EGGS_ID]
    assert response.json()["data"]["untracked"] == [
        {"line": 0, "name": "Salt", "reason": "basic"},
        {"line": 2, "name": "Butter", "reason": "not_in_kitchen"},
    ]


def test_an_unreadable_kitchen_is_unavailable(kitchen):
    app, _, headers = kitchen
    app.dependency_overrides[get_cook_food_source] = lambda: _FailingSource([])

    response = post_plan(kitchen, ingredient("Eggs", EGGS_ID, 2, "egg"))

    assert response.status_code == 503
    assert response.json()["code"] == "COOK_UNAVAILABLE"


def test_signed_out_callers_and_empty_recipes_are_rejected(kitchen):
    app, _, _ = kitchen
    anonymous = TestClient(app).post("/api/cook/plan", json={"household_id": HOUSEHOLD_ID, "ingredients": [ingredient("Eggs", EGGS_ID, 2, "egg")]})
    empty = post_plan(kitchen)

    assert anonymous.status_code == 401
    assert empty.status_code == 422
