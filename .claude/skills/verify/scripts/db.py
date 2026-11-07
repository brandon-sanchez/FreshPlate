"""Read rows from the FreshPlate Supabase project to prove a side effect.

Usage (from the repo root):
  python3 -I .claude/skills/verify/scripts/db.py <table> [postgrest-query]

Examples:
  db.py inventory_items "household_id=eq.<uuid>&select=name,quantity,unit&order=name"
  db.py cook_events "household_id=eq.<uuid>&order=created_at.desc&limit=1"

GET only: this helper cannot write. It authenticates with the backend's secret
key from backend/.env, which bypasses row-level security, so always filter by
household_id and never paste the key anywhere.
"""

import json
import sys
import urllib.error
import urllib.request
from pathlib import Path

ENV_FILE = Path(__file__).resolve().parents[4] / "backend" / ".env"


def load_env() -> dict[str, str]:
    values = {}
    for line in ENV_FILE.read_text().splitlines():
        if "=" in line and not line.lstrip().startswith("#"):
            key, value = line.split("=", 1)
            values[key.strip()] = value.strip().strip("'\"")
    return values


def main() -> None:
    if len(sys.argv) not in (2, 3):
        sys.exit(__doc__)
    table, query = sys.argv[1], sys.argv[2] if len(sys.argv) == 3 else ""
    env = load_env()
    key = env.get("SUPABASE_SECRET_KEY") or env.get("SUPABASE_SERVICE_ROLE_KEY")
    if not key:
        sys.exit("backend/.env has no SUPABASE_SECRET_KEY")
    request = urllib.request.Request(
        f"{env['SUPABASE_URL']}/rest/v1/{table}?{query}",
        method="GET",
        headers={"apikey": key, "Authorization": f"Bearer {key}"},
    )
    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            print(json.dumps(json.load(response), indent=2))
    except urllib.error.HTTPError as error:
        sys.exit(f"{error.code}: {error.read().decode()}")


if __name__ == "__main__":
    main()
