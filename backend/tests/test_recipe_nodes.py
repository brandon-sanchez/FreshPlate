"""Behavior tests for the deterministic recipe graph nodes."""

from __future__ import annotations

from datetime import date
from typing import Any

import pytest

from app.ai.agents.nodes import (
    RETRIEVAL_QUERY_TERM_LIMIT,
    analyze_inventory,
    retrieve_recipes,
)
from app.ai.llm.retry import PipelineDeadline
from app.ai.rag.vector_store import RetrievedRecipe


def _food(
    food_id: str,
    name: str,
    available: float = 1,
    *,
    stock_base: str = "each",
    each_label: str | None = "each",
    **fields: Any,
) -> dict[str, Any]:
    return {
        "id": food_id,
        "name": name,
        "available": available,
        "stock_base": stock_base,
        "each_label": each_label if stock_base == "each" else None,
        **fields,
    }


def test_analyze_inventory_sends_one_line_per_food_with_its_units() -> None:
    state: dict[str, Any] = {
        "inventory": [
            _food(
                "milk",
                "Milk",
                5400,
                stock_base="ml",
                next_expiry="2026-08-20",
                lot_count=2,
            ),
            _food(
                "garlic",
                "Garlic",
                1,
                each_label="head",
                profile_key="garlic",
                profile_unit_grams={"clove": 3, "head": 40},
                next_expiry="2026-08-05",
            ),
            _food("flour", "Flour", 0, stock_base="g"),
        ]
    }

    result = analyze_inventory(state, today=date(2026, 8, 3))

    assert [item["id"] for item in result["usable_items"]] == ["garlic", "milk"]
    garlic, milk = result["usable_items"]
    assert garlic["units"] == [
        "head", "clove", "g", "kg", "oz", "lb", "tsp", "tbsp", "pinch", "dash",
    ]  # fmt: skip
    assert (garlic["quantity"], garlic["unit"], garlic["is_expiring"]) == (
        1,
        "head",
        True,
    )
    assert (milk["quantity"], milk["unit"], milk["lot_count"]) == (5400, "ml", 2)
    assert milk["expiration_date"] == date(2026, 8, 20)
    assert milk["is_expiring"] is False
    assert result["query_terms"] == ["garlic", "milk"]


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
            "Invalid recipe inventory line",
            id="non-mapping-item",
        ),
        pytest.param(
            {"inventory": [_food("bad", "Bad", "many")]},
            "Invalid recipe inventory line",
            id="invalid-available",
        ),
        pytest.param(
            {"inventory": [_food("bad", "Bad", next_expiry="soon")]},
            "Invalid recipe inventory line",
            id="invalid-next-expiry",
        ),
        pytest.param(
            {"inventory": [_food("bad", "Bad", stock_base="each", each_label=None)]},
            "Invalid recipe inventory line",
            id="each-without-label",
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
            _food("today", "Today Item", next_expiry="2026-08-03"),
            _food("boundary", "Boundary Item", next_expiry="2026-08-08"),
            _food("later", "Later Item", next_expiry="2026-08-09"),
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


def test_retrieval_query_leads_with_expiring_and_main_items_and_stays_bounded() -> None:
    pantry = [
        _food(f"spice-{n}", f"Spice {n}", each_label="jar", category="Condiments")
        for n in range(RETRIEVAL_QUERY_TERM_LIMIT)
    ]
    inventory = [
        *pantry,
        _food("salmon", "Salmon", 400, stock_base="g", category="Meat & Seafood"),
        _food(
            "kale",
            "Kale",
            each_label="bunch",
            next_expiry="2026-08-05",
            category="Produce",
        ),
        _food("rice", "Rice", 1000, stock_base="g"),
    ]

    result = analyze_inventory({"inventory": inventory}, today=date(2026, 8, 3))

    assert len(result["usable_items"]) == len(inventory)
    assert result["query_terms"][:2] == ["kale", "salmon"]
    assert len(result["query_terms"]) == RETRIEVAL_QUERY_TERM_LIMIT
    assert result["query_terms"][2:] == [
        f"spice {n}" for n in range(RETRIEVAL_QUERY_TERM_LIMIT - 2)
    ]
