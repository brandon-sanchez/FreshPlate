"""Read a household's foods as the recipe pipeline's inventory lines."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any, Protocol
from uuid import UUID

import httpx
from pydantic import ValidationError

from app.core.config import settings, validate_supabase_url
from app.inventory.food_facts import FoodLine

_STOCK_COLUMNS = (
    "id,name,available,next_expiry:soonest_expiry,lot_count,"
    "category:food_categories(name)"
)
_FACT_COLUMNS = (
    "id,stock_base,each_label,grams_per_each,ml_per_each,g_per_ml,"
    "household_units,profile_key,profile_g_per_ml,profile_unit_grams"
)


class FoodLinesError(RuntimeError):
    """The household's foods could not be read."""


class FoodLineSource(Protocol):
    """Where the recipe API gets a household's foods; tests replace it."""

    async def list_food_lines(self, household_id: UUID) -> list[FoodLine]:
        """Return the household's foods that have unexpired stock.

        Raises:
            FoodLinesError: When the foods cannot be read.
        """
        ...


class SupabaseFoodLineSource:
    """Read ``food_stock`` and ``food_facts`` through PostgREST as the caller.

    Both views run with the caller's rights, so row-level security limits the
    rows to households the caller belongs to. A household the caller is not
    in reads as an empty kitchen, not as an error.
    """

    def __init__(self, user_token: str, *, http_client: httpx.AsyncClient) -> None:
        self._user_token = user_token.strip()
        self._http_client = http_client

    async def list_food_lines(self, household_id: UUID) -> list[FoodLine]:
        """Return one line for each of the household's foods with unexpired stock.

        Makes two PostgREST reads. Expired batches count only toward
        ``food_stock.expired_quantity``, so they never reach ``available``.
        A food deleted between the two reads is left out.

        Raises:
            FoodLinesError: When Supabase is not configured, a read fails or
                times out, or a row is malformed.
        """
        stock_rows = await self._get(
            "food_stock",
            {
                "select": _STOCK_COLUMNS,
                "household_id": f"eq.{household_id}",
                "available": "gt.0",
                "order": "name.asc",
            },
        )
        fact_rows = await self._get(
            "food_facts",
            {"select": _FACT_COLUMNS, "household_id": f"eq.{household_id}"},
        )
        facts_by_id = {row.get("id"): row for row in fact_rows}
        try:
            return [
                FoodLine.model_validate(
                    {
                        **facts_by_id[row["id"]],
                        **row,
                        "category": (row["category"] or {}).get("name"),
                    }
                )
                for row in stock_rows
                if row.get("id") in facts_by_id
            ]
        except (KeyError, TypeError, AttributeError, ValidationError) as exc:
            raise FoodLinesError("Household foods returned invalid rows") from exc

    async def _get(self, view: str, params: Mapping[str, str]) -> list[dict[str, Any]]:
        api_key = settings.supabase_publishable_key or settings.supabase_anon_key
        if not settings.supabase_url or not api_key or not self._user_token:
            raise FoodLinesError("Supabase read credentials are missing")
        try:
            validate_supabase_url(settings.supabase_url)
            response = await self._http_client.get(
                f"{settings.supabase_url.rstrip('/')}/rest/v1/{view}",
                headers={
                    "apikey": api_key,
                    "Authorization": f"Bearer {self._user_token}",
                    "Accept": "application/json",
                },
                params=params,
                timeout=settings.recipe_feed_store_timeout_seconds,
            )
            response.raise_for_status()
            rows = response.json()
        except (ValueError, httpx.HTTPError) as exc:
            raise FoodLinesError(f"Reading {view} failed") from exc
        if not isinstance(rows, list) or not all(isinstance(r, dict) for r in rows):
            raise FoodLinesError(f"{view} returned invalid rows")
        return rows
