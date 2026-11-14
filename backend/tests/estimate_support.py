"""Fake provider, store transport and rows shared by the food fact estimate tests."""

from __future__ import annotations

import json
from collections.abc import Callable, Iterable
from typing import Any

import httpx

from app.ai.llm.providers import FakeProvider, FakeResponse
from app.services.food_profile_store import SupabaseFoodProfileStore

SUPABASE_URL = "https://project.supabase.co"


class RecordingProvider(FakeProvider):
    """A FakeProvider that keeps each prompt it was asked."""

    def __init__(self, responses: Iterable[FakeResponse] = ()) -> None:
        super().__init__(responses)
        self.prompts: list[dict[str, Any]] = []

    async def generate(self, prompt: str, **kwargs: Any) -> Any:
        self.prompts.append(json.loads(prompt))
        return await super().generate(prompt, **kwargs)


def food_row(**changes: Any) -> dict[str, Any]:
    """Return a ``food_facts`` row for garlic stocked in heads, with ``changes``."""
    row = {
        "id": "11111111-1111-1111-1111-111111111111",
        "name": "Garlic",
        "name_key": "garlic",
        "stock_base": "each",
        "each_label": "head",
        "grams_per_each": None,
        "ml_per_each": None,
        "g_per_ml": None,
        "household_units": {},
        "profile_key": "garlic",
        "profile_g_per_ml": 0.5748,
        "profile_unit_grams": {"clove": 3, "cup": 136},
        "profile_estimated_at": None,
    }
    return {**row, **changes}


def unmatched_row(**changes: Any) -> dict[str, Any]:
    """Return a ``food_facts`` row for a food with no profile, with ``changes``."""
    return food_row(
        **{
            "name": "Kirkland creamy peanut butter",
            "name_key": "kirkland creamy peanut butter",
            "stock_base": "g",
            "each_label": None,
            "profile_key": None,
            "profile_g_per_ml": None,
            "profile_unit_grams": None,
            **changes,
        }
    )


class StoreServer:
    """An in-memory PostgREST stand-in that records every request."""

    def __init__(
        self,
        rows: list[dict[str, Any]] | None = None,
        resolve: Callable[[dict[str, Any]], Any] = lambda body: body["p_profile_name"],
    ) -> None:
        self.rows = rows or []
        self.resolve = resolve
        self.requests: list[httpx.Request] = []

    @property
    def saves(self) -> list[dict[str, Any]]:
        return [
            json.loads(request.content)
            for request in self.requests
            if request.method == "POST"
        ]

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if request.method == "GET":
            offset = int(request.url.params["offset"])
            limit = int(request.url.params["limit"])
            return httpx.Response(200, json=self.rows[offset : offset + limit])
        return httpx.Response(200, json=self.resolve(json.loads(request.content)))

    def store(self, **kwargs: Any) -> SupabaseFoodProfileStore:
        options = {"secret_key": "sb_secret_test", **kwargs}
        return SupabaseFoodProfileStore(
            SUPABASE_URL,
            http_client=httpx.AsyncClient(transport=httpx.MockTransport(self.handler)),
            **options,
        )
