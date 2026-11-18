"""Reset the explicitly configured demo household to a seeded kitchen.

The kitchen stocks the fridge, freezer and pantry with foods counted in
grams, millilitres and units. A few batches expire within days, a
few have already expired, several are opened and partly used, and some foods
have two batches, so a demo can show each inventory state. Dates are
relative to the day of the reset.

Usage, from ``backend/``::

    DEMO_DATABASE_URL=... DEMO_HOUSEHOLD_ID=... DEMO_USER_ID=... \\
        python -m app.scripts.seed_demo
"""

# ruff: noqa: E501

from __future__ import annotations

import os
import uuid
from typing import Any

import psycopg
from psycopg.types.json import Jsonb

_Json = dict[str, Any]


def _present(fields: _Json) -> _Json:
    """Drop the fields left at their default, which the reset fills in."""
    return {key: value for key, value in fields.items() if value is not None}


def _lot(
    quantity: float,
    storage_location: str,
    expiration_days: int | None,
    *,
    initial_quantity: float | None = None,
    opened_days_ago: int | None = None,
    notes: str | None = None,
) -> _Json:
    """Describe one batch for ``reset_demo_household``.

    Args:
        quantity: Amount left, in the food's stock base.
        storage_location: ``fridge``, ``freezer`` or ``pantry``.
        expiration_days: Days from the reset to the expiry date. Negative for
            an expired batch, ``None`` for no date.
        initial_quantity: The batch's full amount when some is used. ``None``
            means the batch is full.
        opened_days_ago: Days since the batch was opened. ``None`` means
            unopened.
        notes: A note shown on the batch.
    """
    return _present({
        "quantity": quantity,
        "storage_location": storage_location,
        "expiration_days": expiration_days,
        "initial_quantity": initial_quantity,
        "opened_days_ago": opened_days_ago,
        "notes": notes,
    })


def _food(
    name: str,
    category: str,
    stock_base: str,
    lots: list[_Json],
    *,
    each_label: str | None = None,
    whole_units_only: bool | None = None,
    grams_per_each: float | None = None,
    units: dict[str, float] | None = None,
) -> _Json:
    """Describe one food and its batches for ``reset_demo_household``.

    Args:
        name: The food's display name.
        category: A ``food_categories`` name.
        stock_base: ``g``, ``ml`` or ``each``.
        lots: The food's batches, from ``_lot``.
        each_label: What one counted item is called. Required when
            ``stock_base`` is ``each``.
        whole_units_only: ``True`` for foods counted in whole units only,
            like cans.
        grams_per_each: Weight of one counted item, for recipes in grams.
        units: Household words for the food, as amounts in the stock base.
    """
    return _present({
        "name": name,
        "category": category,
        "stock_base": stock_base,
        "each_label": each_label,
        "whole_units_only": whole_units_only,
        "grams_per_each": grams_per_each,
        "units": units,
        "lots": lots,
    })


_KITCHEN = [
    _food("Milk", "Dairy & Eggs", "ml", [
        _lot(1200, "fridge", 4, initial_quantity=1890, opened_days_ago=3),
        _lot(1890, "fridge", 11),
    ]),
    _food("Eggs", "Dairy & Eggs", "each", [_lot(7, "fridge", 16, initial_quantity=12, opened_days_ago=5)],
          each_label="egg", whole_units_only=True, grams_per_each=50),
    _food("Greek yogurt", "Dairy & Eggs", "g", [_lot(450, "fridge", 2, initial_quantity=907, opened_days_ago=4)]),
    _food("Cheddar cheese", "Dairy & Eggs", "g", [_lot(140, "fridge", 21, initial_quantity=227, opened_days_ago=6)]),
    _food("Butter", "Dairy & Eggs", "g", [_lot(454, "fridge", 60)], units={"stick": 113}),
    _food("Sour cream", "Dairy & Eggs", "g", [_lot(180, "fridge", -3, initial_quantity=454, opened_days_ago=12)]),
    _food("Baby spinach", "Produce", "g", [_lot(140, "fridge", 1)]),
    _food("Strawberries", "Produce", "g", [_lot(300, "fridge", -2, initial_quantity=454, opened_days_ago=5)]),
    _food("Bell peppers", "Produce", "each", [_lot(3, "fridge", 6)],
          each_label="pepper", whole_units_only=True, grams_per_each=160),
    _food("Carrots", "Produce", "g", [_lot(600, "fridge", 18, initial_quantity=907, opened_days_ago=7)]),
    _food("Broccoli", "Produce", "each", [_lot(1, "fridge", 4)], each_label="head", grams_per_each=350),
    _food("Lemons", "Produce", "each", [_lot(3, "fridge", 14)],
          each_label="lemon", whole_units_only=True, grams_per_each=100),
    _food("Cilantro", "Produce", "each", [_lot(1, "fridge", 3)], each_label="bunch", grams_per_each=50),
    _food("Chicken thighs", "Meat & Seafood", "g", [_lot(680, "fridge", 2)]),
    _food("Fried rice", "Leftovers", "each",
          [_lot(1, "fridge", -1, notes="Leftovers from Sunday dinner")], each_label="container"),
    _food("Orange juice", "Beverages", "ml", [_lot(1100, "fridge", 6, initial_quantity=1530, opened_days_ago=4)]),
    _food("Dijon mustard", "Condiments", "g", [_lot(150, "fridge", 150, initial_quantity=227, opened_days_ago=30)]),
    _food("Frozen peas", "Frozen", "g", [_lot(250, "freezer", 150, initial_quantity=454, opened_days_ago=14)]),
    _food("Ground beef", "Meat & Seafood", "g", [
        _lot(454, "freezer", 40),
        _lot(454, "freezer", 75),
    ]),
    _food("Salmon fillets", "Meat & Seafood", "each", [_lot(2, "freezer", 90)],
          each_label="fillet", whole_units_only=True, grams_per_each=170),
    _food("Vanilla ice cream", "Frozen", "ml", [_lot(900, "freezer", 45, initial_quantity=1420, opened_days_ago=9)]),
    _food("Olive oil", "Condiments", "ml", [_lot(600, "pantry", 300, initial_quantity=1000, opened_days_ago=40)]),
    _food("Soy sauce", "Condiments", "ml", [_lot(220, "pantry", 240, initial_quantity=296, opened_days_ago=25)]),
    _food("Spaghetti", "Grains & Bread", "g", [
        _lot(200, "pantry", 400, initial_quantity=454, opened_days_ago=10),
        _lot(454, "pantry", 540),
    ]),
    _food("Jasmine rice", "Grains & Bread", "g", [_lot(1400, "pantry", 365, initial_quantity=2270, opened_days_ago=20)]),
    _food("Rolled oats", "Grains & Bread", "g", [_lot(800, "pantry", 200, initial_quantity=1190, opened_days_ago=15)]),
    _food("Sourdough bread", "Grains & Bread", "each", [_lot(0.5, "pantry", 2, initial_quantity=1, opened_days_ago=2)],
          each_label="loaf", grams_per_each=680),
    _food("Black beans", "Canned Goods", "each", [_lot(3, "pantry", 540)],
          each_label="can", whole_units_only=True, grams_per_each=439),
    _food("Diced tomatoes", "Canned Goods", "each", [_lot(2, "pantry", 480)],
          each_label="can", whole_units_only=True, grams_per_each=411),
    _food("Garlic", "Produce", "each", [_lot(2, "pantry", 30)],
          each_label="head", grams_per_each=50, units={"clove": 0.1}),
    _food("Onions", "Produce", "each", [_lot(4, "pantry", 21)], each_label="onion", grams_per_each=110),
    _food("Bananas", "Produce", "each", [_lot(4, "pantry", 4)],
          each_label="banana", whole_units_only=True, grams_per_each=120),
    _food("Coffee", "Beverages", "g", [_lot(150, "pantry", 25, initial_quantity=340, opened_days_ago=12)]),
]


def main() -> None:
    """Replace the demo household's inventory with the seeded kitchen.

    Reads ``DEMO_DATABASE_URL`` (a service-role connection string),
    ``DEMO_HOUSEHOLD_ID`` and ``DEMO_USER_ID`` from the environment and
    calls ``public.reset_demo_household`` in one transaction, which deletes
    the household's foods, lots and cook history and inserts the seed.

    Raises:
        SystemExit: When a variable is missing or not a UUID, or the reset
            fails. The database refuses a household that is not in
            ``demo_households`` or not owned by the user. The message names
            the error class and SQLSTATE only, never the connection string or
            other database diagnostics.
    """
    household_id = os.environ.get("DEMO_HOUSEHOLD_ID")
    user_id = os.environ.get("DEMO_USER_ID")
    dsn = os.environ.get("DEMO_DATABASE_URL")
    if not dsn:
        raise SystemExit("Set DEMO_DATABASE_URL explicitly; refusing an implicit database target.")
    if not household_id or not user_id:
        raise SystemExit("Set DEMO_HOUSEHOLD_ID and DEMO_USER_ID explicitly.")
    for value, name in ((household_id, "DEMO_HOUSEHOLD_ID"), (user_id, "DEMO_USER_ID")):
        try:
            uuid.UUID(value)
        except ValueError as exc:
            raise SystemExit(f"{name} must be a UUID") from exc
    try:
        with psycopg.connect(dsn) as connection:
            connection.execute(
                "SELECT public.reset_demo_household(%s::uuid, %s::uuid, %s::jsonb)",
                (household_id, user_id, Jsonb(_KITCHEN)),
            )
    except psycopg.Error as exc:
        raise SystemExit(
            f"Demo household reset failed ({type(exc).__name__}, SQLSTATE {exc.sqlstate}); "
            "no database diagnostics beyond the SQLSTATE were exposed."
        ) from None


if __name__ == "__main__":
    main()
