"""Deterministic inventory and retrieval nodes for the recipe graph."""

from __future__ import annotations

import math
import re
from collections.abc import Iterable, Mapping, Sequence
from datetime import date, datetime
from typing import Any, Protocol

from app.ai.agents.state import InventoryAnalysis, RetrievalResult, UsableItem
from app.ai.llm.retry import PipelineDeadline
from app.ai.rag.vector_store import (
    DEFAULT_MATCH_LIMIT,
    DEFAULT_MATCH_THRESHOLD,
    RetrievedRecipe,
)

EXPIRING_WITHIN_DAYS = 5
_QUERY_TERM_SEPARATOR = re.compile(r"[^\w]+", flags=re.UNICODE)


class RecipeRetrieverPort(Protocol):
    """The retrieval seam required by the graph node."""

    async def search(
        self,
        query: str,
        *,
        limit: int,
        match_threshold: float,
        deadline: PipelineDeadline | None,
    ) -> list[RetrievedRecipe]: ...


def analyze_inventory(
    state: Mapping[str, Any],
    *,
    today: date | None = None,
) -> InventoryAnalysis:
    """Filter inventory and produce priority-ordered retrieval inputs.

    Expired, depleted, and zero-quantity rows never reach the generator. Rows
    expiring today through five days from ``today`` are placed first and carry
    an explicit ``is_expiring`` flag for downstream prompt and UI work.
    """
    reference_date = today or date.today()
    raw_inventory = state.get("inventory", [])
    if not isinstance(raw_inventory, Sequence) or isinstance(
        raw_inventory, (str, bytes)
    ):
        raise ValueError("Recipe state inventory must be a sequence")

    candidates: list[tuple[tuple[int, int, int], UsableItem, str]] = []
    for index, raw_item in enumerate(raw_inventory):
        if not isinstance(raw_item, Mapping):
            raise ValueError("Recipe state inventory items must be mappings")

        item_id = _required_text(raw_item, "id")
        name = _required_text(raw_item, "name")
        quantity = _quantity(raw_item.get("quantity", 1))
        if quantity <= 0 or _is_depleted(raw_item.get("depleted_at")):
            continue

        expiration_date = _expiration_date(raw_item.get("expiration_date"))
        if expiration_date is not None and expiration_date < reference_date:
            continue

        days_until_expiration = (
            (expiration_date - reference_date).days
            if expiration_date is not None
            else None
        )
        is_expiring = days_until_expiration is not None and (
            0 <= days_until_expiration <= EXPIRING_WITHIN_DAYS
        )
        unit = _unit(raw_item.get("unit", "item"))
        usable_item: UsableItem = {
            "id": item_id,
            "name": name,
            "quantity": quantity,
            "unit": unit,
            "expiration_date": expiration_date,
            "days_until_expiration": days_until_expiration,
            "is_expiring": is_expiring,
        }
        normalized_name = normalize_query_term(name)
        if not normalized_name:
            raise ValueError(f"Inventory item '{item_id}' has no searchable name")

        priority = 0 if is_expiring else 1
        days_priority = (
            days_until_expiration
            if days_until_expiration is not None and is_expiring
            else 0
        )
        candidates.append(
            ((priority, days_priority, index), usable_item, normalized_name)
        )

    candidates.sort(key=lambda candidate: candidate[0])
    usable_items = [candidate[1] for candidate in candidates]
    query_terms = _unique_terms(candidate[2] for candidate in candidates)
    return {"usable_items": usable_items, "query_terms": query_terms}


async def retrieve_recipes(
    state: Mapping[str, Any],
    retriever: RecipeRetrieverPort,
    *,
    limit: int = DEFAULT_MATCH_LIMIT,
    match_threshold: float = DEFAULT_MATCH_THRESHOLD,
    deadline: PipelineDeadline | None = None,
) -> RetrievalResult:
    """Embed the analyzed query and return the highest-ranked recipe matches."""
    raw_terms = state.get("query_terms", [])
    if not isinstance(raw_terms, Sequence) or isinstance(raw_terms, (str, bytes)):
        raise ValueError("Recipe state query_terms must be a sequence")

    if any(not isinstance(term, str) for term in raw_terms):
        raise ValueError("Recipe state query_terms must contain strings")
    query_terms = _unique_terms(
        normalize_query_term(term) for term in raw_terms
    )
    if not query_terms:
        return {"retrieved_recipes": []}

    recipes = await retriever.search(
        " ".join(query_terms),
        limit=limit,
        match_threshold=match_threshold,
        deadline=deadline,
    )
    return {"retrieved_recipes": recipes}


def normalize_query_term(value: str) -> str:
    """Case-fold and whitespace-normalize one inventory name for retrieval."""
    if not isinstance(value, str):
        raise ValueError("Recipe query terms must be strings")
    return " ".join(_QUERY_TERM_SEPARATOR.sub(" ", value.casefold()).split())


def _required_text(item: Mapping[str, Any], field: str) -> str:
    value = item.get(field)
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"Inventory item '{field}' must be a non-empty string")
    return value


def _quantity(value: Any) -> float:
    try:
        quantity = float(value)
    except (TypeError, ValueError) as exc:
        raise ValueError("Inventory quantity must be numeric") from exc
    if not math.isfinite(quantity):
        raise ValueError("Inventory quantity must be finite")
    return quantity


def _unit(value: Any) -> str:
    if not isinstance(value, str) or not value.strip():
        return "item"
    return value.strip()


def _expiration_date(value: Any) -> date | None:
    if value is None or value == "":
        return None
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    if isinstance(value, str):
        try:
            return date.fromisoformat(value.strip())
        except ValueError as exc:
            raise ValueError("Inventory expiration_date must be ISO formatted") from exc
    raise ValueError("Inventory expiration_date must be a date or ISO string")


def _is_depleted(value: Any) -> bool:
    return value is not None and value != ""


def _unique_terms(terms: Iterable[str]) -> list[str]:
    unique: list[str] = []
    seen: set[str] = set()
    for term in terms:
        if term and term not in seen:
            seen.add(term)
            unique.append(term)
    return unique
