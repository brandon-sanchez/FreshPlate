"""Authenticated recipe suggestion endpoint."""

from __future__ import annotations

import asyncio
from collections.abc import Mapping, Sequence
from typing import Any
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException, status

from app.ai.agents.graph import build_recipe_graph
from app.ai.agents.models import Recipe
from app.ai.agents.nodes import RecipeProviderPort, RecipeRetrieverPort
from app.ai.agents.state import RecipeState
from app.ai.eval.scorers import ingredient_coverage_percent
from app.ai.llm.errors import AI_UNAVAILABLE, ProviderError
from app.ai.llm.providers import GeminiProvider
from app.ai.llm.retry import PipelineDeadline
from app.ai.prompts.loader import load_prompt
from app.ai.prompts.tracing import build_trace_config
from app.ai.rag.embeddings import EmbeddingClient
from app.ai.rag.retriever import RecipeRetriever
from app.ai.rag.vector_store import SupabaseVectorStore
from app.core.auth import CurrentUserId
from app.core.config import settings
from app.models.recipes import (
    RecipeSuggestion,
    RecipeSuggestionRequest,
    RecipeSuggestionsData,
    RecipeSuggestionsResponse,
)

router = APIRouter(prefix="/api/recipes", tags=["recipes"])


def get_recipe_provider() -> RecipeProviderPort:
    """Create the production provider for one request dependency graph."""
    return GeminiProvider()


def get_recipe_retriever() -> RecipeRetrieverPort:
    """Create the production embedding and vector-search seam."""
    return RecipeRetriever(EmbeddingClient(), SupabaseVectorStore())


@router.post("/suggestions", response_model=RecipeSuggestionsResponse)
async def post_recipe_suggestions(
    payload: RecipeSuggestionRequest,
    _user_id: CurrentUserId,
    provider: RecipeProviderPort = Depends(get_recipe_provider),
    retriever: RecipeRetrieverPort = Depends(get_recipe_retriever),
) -> RecipeSuggestionsResponse:
    """Generate one authenticated, session-scoped batch of recipe suggestions."""
    if payload.batch_ceiling == 0:
        return RecipeSuggestionsResponse(
            data=RecipeSuggestionsData(recipes=[]),
        )

    deadline = PipelineDeadline.from_now(settings.ai_pipeline_budget_seconds)
    prompt = load_prompt("generate_recipes")
    graph = build_recipe_graph(provider, retriever, prompt=prompt)
    state: RecipeState = {
        "inventory": [item.model_dump(mode="python") for item in payload.inventory],
        "preferences": payload.preferences,
        "exclude_titles": payload.exclude_titles,
        "batch_ceiling": payload.batch_ceiling,
        "retry_count": 0,
        "metadata": {},
        "deadline": deadline,
    }

    try:
        remaining_seconds = deadline.remaining_seconds
        if remaining_seconds <= 0:
            raise TimeoutError("Recipe pipeline deadline exhausted")
        result = await asyncio.wait_for(
            graph.ainvoke(
                state,
                config=build_trace_config(prompt, request_id=str(uuid4())),
            ),
            timeout=remaining_seconds,
        )
        if deadline.expired:
            raise TimeoutError("Recipe pipeline deadline exhausted")
        recipes = _build_suggestions(result, payload)
    except asyncio.CancelledError:
        raise
    except (ProviderError, TimeoutError, ValueError) as exc:
        raise _ai_unavailable() from exc

    return RecipeSuggestionsResponse(
        data=RecipeSuggestionsData(recipes=recipes),
    )


def _build_suggestions(
    result: Any,
    payload: RecipeSuggestionRequest,
) -> list[RecipeSuggestion]:
    if not isinstance(result, Mapping):
        raise ValueError("Recipe graph returned an invalid state")

    raw_inventory = result.get("usable_items", [])
    raw_recipes = result.get("valid_recipes", [])
    if not _is_sequence_of_mappings_or_models(raw_inventory) or not isinstance(
        raw_recipes, Sequence
    ) or isinstance(raw_recipes, (str, bytes)):
        raise ValueError("Recipe graph returned an invalid recipe state")

    excluded_titles = {
        _normalize_title(title) for title in payload.exclude_titles if title.strip()
    }
    suggestions: list[RecipeSuggestion] = []
    for raw_recipe in raw_recipes:
        recipe = Recipe.model_validate(raw_recipe)
        if _normalize_title(recipe.title) in excluded_titles:
            continue
        suggestions.append(
            RecipeSuggestion(
                **recipe.model_dump(mode="python"),
                recipe_id=uuid4(),
                match_percent=ingredient_coverage_percent(recipe, raw_inventory),
                saves_expiring=_expiring_item_names(recipe, raw_inventory),
            )
        )
        if len(suggestions) >= payload.batch_ceiling:
            break
    return suggestions


def _expiring_item_names(
    recipe: Recipe,
    inventory: Sequence[Mapping[str, Any]],
) -> list[str]:
    by_id = {
        item_id: item
        for item in inventory
        if isinstance(item_id := item.get("id"), str) and item_id
    }
    names: list[str] = []
    seen: set[str] = set()
    for ingredient in recipe.ingredients:
        item_id = ingredient.inventory_item_id
        item = by_id.get(item_id) if item_id is not None else None
        if item is None or not item.get("is_expiring"):
            continue
        name = item.get("name")
        if isinstance(name, str) and name not in seen:
            names.append(name)
            seen.add(name)
    return names


def _is_sequence_of_mappings_or_models(value: Any) -> bool:
    if not isinstance(value, Sequence) or isinstance(value, (str, bytes)):
        return False
    return all(isinstance(item, Mapping) for item in value)


def _normalize_title(value: str) -> str:
    return " ".join(value.casefold().split())


def _ai_unavailable() -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
        detail={
            "error": "AI service unavailable",
            "code": AI_UNAVAILABLE,
        },
    )
