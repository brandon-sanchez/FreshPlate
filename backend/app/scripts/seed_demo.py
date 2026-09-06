"""Reset the explicitly configured FreshPlate demo household."""
# ruff: noqa: E501

from __future__ import annotations

import json
import os
import subprocess
import uuid
from urllib.parse import urlsplit

ITEMS = [
    ("Baby spinach", 1, "bag", "Produce", 2, "fridge"),
    ("Avocados", 3, "each", "Produce", 3, "fridge"),
    ("Bell peppers", 3, "each", "Produce", 4, "fridge"),
    ("Broccoli", 1, "head", "Produce", 5, "fridge"),
    ("Carrots", 5, "each", "Produce", 8, "fridge"),
    ("Bananas", 5, "each", "Produce", 4, "pantry"),
    ("Eggs", 6, "each", "Dairy & Eggs", 12, "fridge"),
    ("Greek yogurt", 1, "tub", "Dairy & Eggs", 6, "fridge"),
    ("Cheddar cheese", 1, "block", "Dairy & Eggs", 14, "fridge"),
    ("Chicken breast", 2, "lb", "Meat & Seafood", 2, "fridge"),
    ("Salmon fillets", 2, "each", "Meat & Seafood", 3, "fridge"),
    ("Sourdough bread", 1, "loaf", "Grains & Bread", 5, "pantry"),
    ("Brown rice", 2, "lb", "Grains & Bread", 180, "pantry"),
    ("Pasta", 1, "box", "Grains & Bread", 365, "pantry"),
    ("Black beans", 2, "can", "Canned Goods", 365, "pantry"),
    ("Diced tomatoes", 2, "can", "Canned Goods", 365, "pantry"),
    ("Olive oil", 1, "bottle", "Condiments", 180, "pantry"),
    ("Soy sauce", 1, "bottle", "Condiments", 180, "pantry"),
    ("Frozen peas", 1, "bag", "Frozen", 90, "freezer"),
    ("Coffee", 1, "bag", "Beverages", 30, "pantry"),
]


def main() -> None:
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
    items = [
        {
            "name": name,
            "quantity": quantity,
            "unit": unit,
            "category": category,
            "expiration_days": days,
            "storage_location": location,
        }
        for name, quantity, unit, category, days, location in ITEMS
    ]
    # PostgreSQL computes relative dates in the transaction, keeping the seed current.
    payload = json.dumps(items)
    parsed = urlsplit(dsn)
    if not parsed.hostname or parsed.hostname not in {"localhost", "127.0.0.1", "::1"}:
        raise SystemExit("DEMO_DATABASE_URL must target an explicitly approved local database")
    sql = "SELECT public.reset_demo_household(:'household_id'::uuid, :'user_id'::uuid, :'payload'::jsonb);"
    env = os.environ.copy()
    env.update({"PGHOST": parsed.hostname, "PGPORT": str(parsed.port or 5432), "PGUSER": parsed.username or "postgres", "PGDATABASE": parsed.path.lstrip("/")})
    if parsed.password:
        env["PGPASSWORD"] = parsed.password
    subprocess.run(["psql", "--no-psqlrc", "--tuples-only", "--set", f"household_id={household_id}", "--set", f"user_id={user_id}", "--set", f"payload={payload}"], input=sql, text=True, env=env, check=True, capture_output=True)


if __name__ == "__main__":
    main()
