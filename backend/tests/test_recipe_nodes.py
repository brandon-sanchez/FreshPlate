"""Behavior tests for the deterministic recipe graph nodes."""

from __future__ import annotations

from datetime import date
from typing import Any

import pytest

from app.ai.agents.nodes import analyze_inventory, retrieve_recipes
from app.ai.llm.retry import PipelineDeadline
from app.ai.rag.vector_store import RetrievedRecipe


def test_analyze_inventory_filters_unusable_items_and_prioritizes_expiry() -> None:
    state: dict[str, Any] = {
        "inventory": [
            {
                "id": "spinach",
                "name": "  Baby   Spinach!! ",
                "quantity": 1,
                "unit": "bag",
                "expiration_date": "2026-08-05",
            },
            {
                "id": "expired",
                "name": "Expired Yogurt",
                "quantity": 1,
                "unit": "cup",
                "expiration_date": "2026-08-02",
            },
            {
                "id": "depleted",
                "name": "Used Flour",
                "quantity": 0,
                "unit": "bag",
                "expiration_date": None,
                "depleted_at": "2026-08-03T08:00:00Z",
            },
            {
                "id": "tomatoes",
                "name": "Tomatoes",
                "quantity": 3,
                "unit": "item",
                "expiration_date": "2026-08-20",
            },
            {
                "id": "duplicate-name",
                "name": "baby spinach",
                "quantity": 2,
                "unit": "item",
                "expiration_date": None,
            },
        ]
    }

    result = analyze_inventory(state, today=date(2026, 8, 3))

    assert [item["id"] for item in result["usable_items"]] == [
        "spinach",
        "tomatoes",
        "duplicate-name",
    ]
    assert result["usable_items"][0] == {
        "id": "spinach",
        "name": "  Baby   Spinach!! ",
        "quantity": 1.0,
        "unit": "bag",
        "expiration_date": date(2026, 8, 5),
        "days_until_expiration": 2,
        "is_expiring": True,
    }
    assert result["usable_items"][1]["is_expiring"] is False
    assert result["query_terms"] == ["baby spinach", "tomatoes"]


@pytest.mark.parametrize(
    ("state", "match"),
    [
        pytest.param(
            {"inventory": "not-a-sequence"},
            "inventory must be a sequence",
            id="non-sequence-inventory",
        ),
        pytest.param(
            {"inventory": ["not-a-mapping"]},
            "items must be mappings",
            id="non-mapping-item",
        ),
        pytest.param(
            {"inventory": [{"id": "bad", "name": "Bad Item", "quantity": "many"}]},
            "quantity must be numeric",
            id="invalid-quantity",
        ),
        pytest.param(
            {
                "inventory": [
                    {"id": "bad", "name": "Bad Item", "expiration_date": "soon"}
                ]
            },
            "expiration_date must be ISO formatted",
            id="invalid-expiration-date",
        ),
    ],
)
def test_analyze_inventory_rejects_malformed_input(
    state: dict[str, Any], match: str
) -> None:
    with pytest.raises(ValueError, match=match):
        analyze_inventory(state, today=date(2026, 8, 3))


def test_analyze_inventory_flags_the_five_day_boundary_and_today() -> None:
    state: dict[str, Any] = {
        "inventory": [
            {
                "id": "today",
                "name": "Today Item",
                "expiration_date": "2026-08-03",
            },
            {
                "id": "boundary",
                "name": "Boundary Item",
                "expiration_date": "2026-08-08",
            },
            {
                "id": "later",
                "name": "Later Item",
                "expiration_date": "2026-08-09",
            },
        ]
    }

    result = analyze_inventory(state, today=date(2026, 8, 3))

    assert [item["is_expiring"] for item in result["usable_items"]] == [
        True,
        True,
        False,
    ]
    assert [item["days_until_expiration"] for item in result["usable_items"]] == [
        0,
        5,
        6,
    ]


class FakeRecipeRetriever:
    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []

    async def search(self, query: str, **kwargs: Any) -> list[RetrievedRecipe]:
        self.calls.append({"query": query, **kwargs})
        return [
            RetrievedRecipe(
                id=101,
                title="Spinach Pasta",
                content="Cook spinach with pasta.",
                similarity=0.92,
            )
        ]


@pytest.mark.asyncio
async def test_retrieve_recipes_passes_normalized_terms_and_shared_deadline() -> None:
    retriever = FakeRecipeRetriever()
    deadline = PipelineDeadline(5.0)

    result = await retrieve_recipes(
        {"query_terms": [" Baby---SPINACH ", "baby spinach", "tomatoes"]},
        retriever,
        limit=3,
        match_threshold=0.65,
        deadline=deadline,
    )

    assert result["retrieved_recipes"][0].title == "Spinach Pasta"
    assert retriever.calls == [
        {
            "query": "baby spinach tomatoes",
            "limit": 3,
            "match_threshold": 0.65,
            "deadline": deadline,
        }
    ]


@pytest.mark.asyncio
async def test_retrieve_recipes_returns_no_results_without_query_terms() -> None:
    retriever = FakeRecipeRetriever()

    result = await retrieve_recipes({}, retriever)

    assert result == {"retrieved_recipes": []}
    assert retriever.calls == []
