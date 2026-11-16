"""PostgREST contract tests for reading a household's foods."""

from __future__ import annotations

from datetime import date
from typing import Any
from uuid import UUID

import httpx
import pytest

from app.services.food_lines import FoodLinesError, SupabaseFoodLineSource

HOUSEHOLD = UUID("00000000-0000-4000-8000-0000000000aa")
STOCK_ROW = {
    "id": "f-garlic",
    "name": "Garlic",
    "available": 2,
    "next_expiry": "2026-11-20",
    "lot_count": 2,
    "category": {"name": "Produce"},
}
FACTS_ROW = {
    "id": "f-garlic",
    "stock_base": "each",
    "each_label": "head",
    "grams_per_each": None,
    "ml_per_each": None,
    "g_per_ml": None,
    "household_units": {},
    "profile_key": "garlic",
    "profile_g_per_ml": None,
    "profile_unit_grams": {"clove": 3, "head": 40},
}


def _client(
    bodies: dict[str, Any], status: int = 200
) -> tuple[httpx.AsyncClient, list[httpx.Request]]:
    requests: list[httpx.Request] = []

    def respond(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(status, json=bodies[request.url.path.rsplit("/", 1)[-1]])

    return httpx.AsyncClient(transport=httpx.MockTransport(respond)), requests


@pytest.fixture(autouse=True)
def supabase_settings(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        "app.services.food_lines.settings.supabase_url", "https://project.supabase.co"
    )
    monkeypatch.setattr(
        "app.services.food_lines.settings.supabase_publishable_key", "publishable"
    )


@pytest.mark.asyncio
async def test_reads_unexpired_stock_and_facts_as_the_caller() -> None:
    http, requests = _client({"food_stock": [STOCK_ROW], "food_facts": [FACTS_ROW]})

    [line] = await SupabaseFoodLineSource(
        " user-jwt ", http_client=http
    ).list_food_lines(HOUSEHOLD)

    assert (line.id, line.name, line.available, line.lot_count) == (
        "f-garlic",
        "Garlic",
        2,
        2,
    )
    assert (line.next_expiry, line.category, line.stock_unit) == (
        date(2026, 11, 20),
        "Produce",
        "head",
    )
    assert line.profile_unit_grams == {"clove": 3, "head": 40}
    stock_call, facts_call = requests
    assert stock_call.url.path == "/rest/v1/food_stock"
    assert stock_call.url.params["household_id"] == f"eq.{HOUSEHOLD}"
    assert stock_call.url.params["available"] == "gt.0"
    assert "next_expiry:soonest_expiry" in stock_call.url.params["select"]
    assert facts_call.url.params["household_id"] == f"eq.{HOUSEHOLD}"
    assert stock_call.headers["Authorization"] == "Bearer user-jwt"
    assert stock_call.headers["apikey"] == "publishable"


@pytest.mark.asyncio
async def test_a_failed_read_raises_food_lines_error() -> None:
    http, _ = _client({"food_stock": {"message": "boom"}}, status=500)

    with pytest.raises(FoodLinesError, match="Reading food_stock failed"):
        await SupabaseFoodLineSource(
            "user-jwt", http_client=http
        ).list_food_lines(HOUSEHOLD)


@pytest.mark.asyncio
async def test_a_food_deleted_between_the_two_reads_is_left_out() -> None:
    http, _ = _client({"food_stock": [STOCK_ROW], "food_facts": []})

    lines = await SupabaseFoodLineSource(
        "user-jwt", http_client=http
    ).list_food_lines(HOUSEHOLD)

    assert lines == []


@pytest.mark.asyncio
async def test_a_malformed_row_raises_food_lines_error() -> None:
    http, _ = _client(
        {
            "food_stock": [STOCK_ROW],
            "food_facts": [{**FACTS_ROW, "grams_per_each": 0}],
        }
    )

    with pytest.raises(FoodLinesError, match="invalid rows"):
        await SupabaseFoodLineSource(
            "user-jwt", http_client=http
        ).list_food_lines(HOUSEHOLD)
