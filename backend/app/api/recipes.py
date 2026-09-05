"""Authenticated recipe suggestion endpoint."""

from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import Awaitable, Callable, Mapping, Sequence
from typing import Any
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.encoders import jsonable_encoder

from app.ai.agents.graph import build_recipe_generation_graph, build_recipe_graph
from app.ai.agents.models import Recipe
from app.ai.agents.nodes import (
    GENERATION_DOCS_CEILING,
    RecipeProviderPort,
    RecipeRetrieverPort,
)
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
    RecipeFeedData,
    RecipeFeedPageRequest,
    RecipeFeedResponse,
    RecipeFeedSessionRequest,
    RecipeInventoryContext,
    RecipeSuggestion,
    RecipeSuggestionRequest,
    RecipeSuggestionsData,
    RecipeSuggestionsResponse,
)
from app.services.recipe_feed_store import (
    RecipeFeedSession,
    RecipeFeedStore,
    RecipeFeedStoreError,
    SupabaseRecipeFeedStore,
)

router = APIRouter(prefix="/api/recipes", tags=["recipes"])
logger = logging.getLogger("freshplate.recipes")

RECIPE_FEED_INITIAL_HEAD_BATCH_CEILING = 5
RECIPE_FEED_REFILL_BATCH_CEILING = 5
RECIPE_FEED_MAX_GENERATION_RUNS = 6
RECIPE_FEED_INITIAL_QUALITY_RETRY_LIMIT = 1
RECIPE_FEED_INITIAL_RETRY_ONLY_WHEN_EMPTY = True
RECIPE_FEED_REFILL_QUALITY_RETRY_LIMIT = 0
RECIPE_FEED_RETRIEVAL_POOL_LIMIT = (
    GENERATION_DOCS_CEILING * RECIPE_FEED_MAX_GENERATION_RUNS
)

RECIPE_FEED_EMPTY_REASON_UNSUPPORTED_INVENTORY = "INVENTORY_UNSUPPORTED"


def get_recipe_provider() -> RecipeProviderPort:
    """Create the production provider for one request dependency graph."""
    return GeminiProvider()


def get_recipe_retriever(request: Request) -> RecipeRetrieverPort:
    """Create the production embedding and vector-search seam."""
    return RecipeRetriever(
        EmbeddingClient(),
        SupabaseVectorStore(http_client=request.app.state.supabase_http_client),
    )


def get_recipe_feed_store(request: Request) -> RecipeFeedStore:
    """Bind user-scoped reads and trusted writes to the shared HTTP client."""
    authorization = request.headers.get("authorization", "")
    scheme, _, token = authorization.partition(" ")
    if scheme.casefold() != "bearer" or not token.strip():
        raise _feed_unavailable()
    return SupabaseRecipeFeedStore(
        token, http_client=request.app.state.supabase_http_client
    )


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
    state = _initial_recipe_state(payload, deadline=deadline)

    try:
        result = await _invoke_recipe_graph(
            build_recipe_graph(provider, retriever, prompt=prompt),
            state,
            prompt,
        )
        recipes = _build_suggestions(result, payload)
    except asyncio.CancelledError:
        raise
    except (ProviderError, TimeoutError, ValueError) as exc:
        raise _ai_unavailable() from exc

    return RecipeSuggestionsResponse(
        data=RecipeSuggestionsData(recipes=recipes),
    )


@router.post("/sessions", response_model=RecipeFeedResponse)
async def post_recipe_feed_session(
    payload: RecipeFeedSessionRequest,
    _user_id: CurrentUserId,
    store: RecipeFeedStore = Depends(get_recipe_feed_store),
    provider: RecipeProviderPort = Depends(get_recipe_provider),
    retriever: RecipeRetrieverPort = Depends(get_recipe_retriever),
) -> RecipeFeedResponse:
    """Create a feed session and persist its first bounded candidate pool."""
    suggestion_request = RecipeSuggestionRequest(
        inventory=payload.inventory,
        preferences=payload.preferences,
        batch_ceiling=RECIPE_FEED_INITIAL_HEAD_BATCH_CEILING,
    )
    prompt = load_prompt("generate_recipes")
    deadline = PipelineDeadline.from_now(settings.recipe_feed_initial_budget_seconds)
    state: RecipeState = _initial_recipe_state(suggestion_request, deadline=deadline)

    started_at = time.monotonic()
    try:
        result = await _invoke_recipe_graph(
            build_recipe_graph(
                provider,
                retriever,
                prompt=prompt,
                quality_retry_limit=RECIPE_FEED_INITIAL_QUALITY_RETRY_LIMIT,
                retry_only_when_no_valid=RECIPE_FEED_INITIAL_RETRY_ONLY_WHEN_EMPTY,
                retrieval_limit=RECIPE_FEED_RETRIEVAL_POOL_LIMIT,
            ),
            state,
            prompt,
        )
        logger.info(
            "Recipe feed session generated in %.2fs: generated=%d valid=%d "
            "retry_count=%s quality_feedback=%r",
            time.monotonic() - started_at,
            len(result.get("generated_recipes", [])),
            len(result.get("valid_recipes", [])),
            result.get("retry_count"),
            (result.get("quality_feedback") or "")[:200],
        )
        recipes = _build_suggestions(result, suggestion_request)
        session = _session_from_initial_result(
            _user_id,
            suggestion_request,
            result,
            len(recipes),
        )
        session = session.model_copy(
            update={
                "exclude_titles": _unique_titles([recipe.title for recipe in recipes])
            }
        )
        if not recipes:
            session = session.model_copy(update={"has_more": False})
        await _within_recipe_deadline(
            deadline,
            lambda: store.create_session(session, recipes=recipes),
        )
    except asyncio.CancelledError:
        raise
    except (ProviderError, TimeoutError, ValueError) as exc:
        logger.warning(
            "Recipe feed session failed after %.2fs: %s",
            time.monotonic() - started_at,
            exc,
        )
        raise _ai_unavailable() from exc
    except RecipeFeedStoreError as exc:
        logger.warning(
            "Recipe feed session store failure after %.2fs: %s",
            time.monotonic() - started_at,
            exc,
        )
        raise _feed_unavailable() from exc

    return _feed_response(
        session,
        recipes,
        cursor=0,
        empty_reason=(
            None if recipes else RECIPE_FEED_EMPTY_REASON_UNSUPPORTED_INVENTORY
        ),
    )


@router.post(
    "/sessions/{session_id}/pages",
    response_model=RecipeFeedResponse,
)
async def post_recipe_feed_page(
    session_id: UUID,
    payload: RecipeFeedPageRequest,
    _user_id: CurrentUserId,
    store: RecipeFeedStore = Depends(get_recipe_feed_store),
    provider: RecipeProviderPort = Depends(get_recipe_provider),
) -> RecipeFeedResponse:
    """Return a stable cursor page, refilling the pool only at its tail."""
    cursor = _parse_feed_cursor(payload.cursor)
    deadline = PipelineDeadline.from_now(settings.recipe_feed_page_budget_seconds)
    try:
        session = await _within_recipe_deadline(
            deadline,
            lambda: store.get_session(_user_id, session_id),
        )
        if session is None:
            raise _feed_not_found()
        if cursor > session.candidate_count:
            raise _invalid_feed_cursor()

        recipes = await _within_recipe_deadline(
            deadline,
            lambda: store.list_candidates(
                _user_id,
                session_id,
                start_position=cursor,
                limit=payload.limit,
            ),
        )
        if len(recipes) < payload.limit and session.has_more:
            session, added = await _refill_recipe_feed_session(
                session,
                _user_id,
                store,
                provider,
                deadline,
            )
            if added:
                recipes = await _within_recipe_deadline(
                    deadline,
                    lambda: store.list_candidates(
                        _user_id,
                        session_id,
                        start_position=cursor,
                        limit=payload.limit,
                    ),
                )
    except asyncio.CancelledError:
        raise
    except HTTPException:
        raise
    except (ProviderError, TimeoutError, ValueError) as exc:
        logger.warning("Recipe feed page failed: %s", exc)
        raise _ai_unavailable() from exc
    except RecipeFeedStoreError as exc:
        logger.warning("Recipe feed page store failure: %s", exc)
        raise _feed_unavailable() from exc

    return _feed_response(session, recipes, cursor=cursor)


async def _refill_recipe_feed_session(
    session: RecipeFeedSession,
    user_id: str,
    store: RecipeFeedStore,
    provider: RecipeProviderPort,
    deadline: PipelineDeadline,
) -> tuple[RecipeFeedSession, bool]:
    """Generate one tail batch using the session's cached retrieval context."""
    original_count = session.candidate_count
    claim_id = uuid4()
    claimed = await _within_recipe_deadline(
        deadline,
        lambda: store.claim_refill(
            user_id,
            session.id,
            expected_generation_runs=session.generation_runs,
            claim_id=claim_id,
        ),
    )
    if claimed.refill_claim_id != claim_id:
        # Another request owns the tail. Read its committed pool once it finishes
        # so duplicate cursor requests return the same stable recipe ids.
        while claimed.refill_claim_id is not None:
            await _within_recipe_deadline(deadline, lambda: asyncio.sleep(0.2))
            current = await _within_recipe_deadline(
                deadline, lambda: store.get_session(user_id, session.id)
            )
            if current is None:
                raise _feed_not_found()
            claimed = current
        return claimed, claimed.candidate_count > original_count
    try:
        return await _generate_claimed_recipe_refill(
            claimed,
            user_id,
            store,
            provider,
            deadline,
            claim_id,
        )
    except Exception:
        # Cleanup is conditional on the claim, so a lost finalize response cannot
        # undo a committed batch. Cancellation and exhausted budgets use expiry.
        if deadline.remaining_seconds > 0:
            try:
                await _within_recipe_deadline(
                    deadline,
                    lambda: store.release_refill(
                        user_id, session.id, claim_id=claim_id
                    ),
                )
            except (RecipeFeedStoreError, TimeoutError):
                logger.warning("Recipe feed claim will recover after lease expiry")
        raise


async def _generate_claimed_recipe_refill(
    session: RecipeFeedSession,
    user_id: str,
    store: RecipeFeedStore,
    provider: RecipeProviderPort,
    deadline: PipelineDeadline,
    claim_id: UUID,
) -> tuple[RecipeFeedSession, bool]:
    """Generate and finalize the batch owned by one database reservation."""
    inventory = [
        RecipeInventoryContext.model_validate(item) for item in session.inventory
    ]
    suggestion_request = RecipeSuggestionRequest(
        inventory=inventory,
        preferences=session.preferences,
        exclude_titles=session.exclude_titles,
        batch_ceiling=RECIPE_FEED_REFILL_BATCH_CEILING,
    )
    prompt = load_prompt("generate_recipes")
    retrieval_window = session.retrieved_recipes[
        session.retrieval_cursor : session.retrieval_cursor + GENERATION_DOCS_CEILING
    ]
    state: RecipeState = {
        "preferences": session.preferences,
        "exclude_titles": session.exclude_titles,
        "batch_ceiling": RECIPE_FEED_REFILL_BATCH_CEILING,
        "usable_items": session.usable_items,
        "retrieved_recipes": retrieval_window,
        "retry_count": 0,
        "metadata": {},
        "deadline": deadline,
    }
    result = await _invoke_recipe_graph(
        build_recipe_generation_graph(
            provider,
            prompt=prompt,
            quality_retry_limit=RECIPE_FEED_REFILL_QUALITY_RETRY_LIMIT,
        ),
        state,
        prompt,
    )
    generated = _build_suggestions(result, suggestion_request)
    existing_titles = {_normalize_title(title) for title in session.exclude_titles}
    recipes = [
        recipe
        for recipe in generated
        if _normalize_title(recipe.title) not in existing_titles
    ]
    next_exclusions = _unique_titles(
        [*session.exclude_titles, *(recipe.title for recipe in recipes)]
    )
    next_retrieval_cursor = min(
        session.retrieval_cursor + GENERATION_DOCS_CEILING,
        len(session.retrieved_recipes),
    )

    persisted = await _within_recipe_deadline(
        deadline,
        lambda: store.finalize_refill(
            user_id,
            session.id,
            claim_id=claim_id,
            recipes=recipes,
            exclude_titles=next_exclusions,
            retrieval_cursor=next_retrieval_cursor,
        ),
    )
    return persisted, bool(recipes)


async def _invoke_recipe_graph(
    graph: Any,
    state: RecipeState,
    prompt: Any,
) -> Mapping[str, Any]:
    deadline = state.get("deadline")
    if not isinstance(deadline, PipelineDeadline):
        raise ValueError("Recipe state deadline must be a PipelineDeadline")
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
    if not isinstance(result, Mapping):
        raise ValueError("Recipe graph returned an invalid state")
    return result


async def _within_recipe_deadline(
    deadline: PipelineDeadline,
    operation: Callable[[], Awaitable[Any]],
) -> Any:
    remaining_seconds = deadline.remaining_seconds
    if remaining_seconds <= 0:
        raise TimeoutError("Recipe feed request deadline exhausted")
    return await asyncio.wait_for(operation(), timeout=remaining_seconds)


def _initial_recipe_state(
    payload: RecipeSuggestionRequest,
    *,
    deadline: PipelineDeadline | None = None,
) -> RecipeState:
    return {
        "inventory": [item.model_dump(mode="python") for item in payload.inventory],
        "preferences": payload.preferences,
        "exclude_titles": payload.exclude_titles,
        "batch_ceiling": payload.batch_ceiling,
        "retry_count": 0,
        "metadata": {},
        "deadline": deadline
        or PipelineDeadline.from_now(settings.ai_pipeline_budget_seconds),
    }


def _session_from_initial_result(
    user_id: str,
    payload: RecipeSuggestionRequest,
    result: Mapping[str, Any],
    candidate_count: int,
) -> RecipeFeedSession:
    usable_items = result.get("usable_items", [])
    retrieved_recipes = result.get("retrieved_recipes", [])
    if not isinstance(usable_items, Sequence) or isinstance(usable_items, (str, bytes)):
        raise ValueError("Recipe graph returned invalid usable inventory")
    if not isinstance(retrieved_recipes, Sequence) or isinstance(
        retrieved_recipes, (str, bytes)
    ):
        raise ValueError("Recipe graph returned invalid retrieval context")
    return RecipeFeedSession(
        id=uuid4(),
        user_id=user_id,
        inventory=jsonable_encoder(
            [item.model_dump(mode="json") for item in payload.inventory]
        ),
        preferences=jsonable_encoder(payload.preferences),
        usable_items=jsonable_encoder(list(usable_items)),
        retrieved_recipes=jsonable_encoder(list(retrieved_recipes)),
        retrieval_cursor=min(GENERATION_DOCS_CEILING, len(retrieved_recipes)),
        exclude_titles=[],
        candidate_count=candidate_count,
        generation_runs=1,
        has_more=bool(usable_items),
    )


def _feed_response(
    session: RecipeFeedSession,
    recipes: Sequence[RecipeSuggestion],
    *,
    cursor: int,
    empty_reason: str | None = None,
) -> RecipeFeedResponse:
    next_position = cursor + len(recipes)
    has_more = next_position < session.candidate_count or session.has_more
    return RecipeFeedResponse(
        data=RecipeFeedData(
            session_id=session.id,
            recipes=list(recipes),
            next_cursor=str(next_position) if has_more else None,
            has_more=has_more,
            ready_count=session.candidate_count,
            empty_reason=empty_reason,
        )
    )


def _parse_feed_cursor(value: str) -> int:
    if not value.isascii() or not value.isdecimal():
        raise _invalid_feed_cursor()
    return int(value)


def _invalid_feed_cursor() -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
        detail={
            "error": "Invalid recipe feed cursor",
            "code": "RECIPE_FEED_INVALID_CURSOR",
        },
    )


def _build_suggestions(
    result: Any,
    payload: RecipeSuggestionRequest,
) -> list[RecipeSuggestion]:
    if not isinstance(result, Mapping):
        raise ValueError("Recipe graph returned an invalid state")

    raw_inventory = result.get("usable_items", [])
    raw_recipes = result.get("valid_recipes", [])
    if (
        not _is_sequence_of_mappings_or_models(raw_inventory)
        or not isinstance(raw_recipes, Sequence)
        or isinstance(raw_recipes, (str, bytes))
    ):
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


def _unique_titles(titles: Sequence[str]) -> list[str]:
    seen: set[str] = set()
    unique: list[str] = []
    for title in titles:
        normalized = _normalize_title(title)
        if not normalized or normalized in seen:
            continue
        seen.add(normalized)
        unique.append(title.strip())
    return unique


def _ai_unavailable() -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
        detail={
            "error": "AI service unavailable",
            "code": AI_UNAVAILABLE,
        },
    )


def _feed_unavailable() -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
        detail={
            "error": "Recipe feed unavailable",
            "code": "RECIPE_FEED_UNAVAILABLE",
        },
    )


def _feed_not_found() -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_404_NOT_FOUND,
        detail={
            "error": "Recipe feed session not found",
            "code": "RECIPE_FEED_NOT_FOUND",
        },
    )
