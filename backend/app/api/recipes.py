"""Authenticated recipe suggestion endpoint."""

from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import Awaitable, Callable, Mapping, Sequence
from itertools import takewhile
from typing import Any, NamedTuple
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.encoders import jsonable_encoder

from app.ai.agents.dish import requested_dish
from app.ai.agents.diversity import title_key
from app.ai.agents.graph import build_recipe_generation_graph, build_recipe_graph
from app.ai.agents.kitchen_basics import KitchenBasics
from app.ai.agents.models import Recipe
from app.ai.agents.nodes import (
    GENERATION_DOCS_CEILING,
    RecipeRetrieverPort,
)
from app.ai.agents.photos import RecipePhotoSource, photograph
from app.ai.agents.state import RecipeState, RecipeSteering
from app.ai.eval.scorers import ingredient_coverage_percent
from app.ai.llm.errors import AI_UNAVAILABLE, ProviderError
from app.ai.llm.protocol import LLMProvider
from app.ai.llm.providers import GeminiProvider
from app.ai.llm.retry import PipelineDeadline
from app.ai.prompts.loader import load_prompt
from app.ai.prompts.tracing import build_trace_config
from app.ai.rag.embeddings import EmbeddingClient
from app.ai.rag.retriever import RecipeRetriever
from app.ai.rag.vector_store import SupabaseVectorStore
from app.api.images import get_image_service
from app.core.auth import CurrentUserId
from app.core.config import settings
from app.inventory.food_facts import FoodLine
from app.models.images import ImageResult
from app.models.recipes import (
    RecipeFeedCard,
    RecipeFeedData,
    RecipeFeedPageRequest,
    RecipeFeedResponse,
    RecipeFeedSessionRequest,
    RecipeSuggestion,
    RecipeSuggestionRequest,
    RecipeSuggestionsData,
    RecipeSuggestionsResponse,
)
from app.services.food_lines import (
    FoodLinesError,
    FoodLineSource,
    SupabaseFoodLineSource,
)
from app.services.image_service import (
    ImageService,
    ImageStoreError,
    RequesterRecipePhotos,
)
from app.services.recipe_feed_store import (
    RecipeFeedSession,
    RecipeFeedStore,
    RecipeFeedStoreError,
    SupabaseRecipeFeedStore,
)
from app.services.recipe_steering import resolve_steering

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


def get_recipe_provider() -> LLMProvider:
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
    return SupabaseRecipeFeedStore(
        _bearer_token(request, _feed_unavailable),
        http_client=request.app.state.supabase_http_client,
    )


def get_food_line_source(request: Request) -> FoodLineSource:
    """Read the caller's household foods with the caller's own token."""
    return SupabaseFoodLineSource(
        _bearer_token(request, _ai_unavailable),
        http_client=request.app.state.supabase_http_client,
    )


def _bearer_token(request: Request, unavailable: Callable[[], HTTPException]) -> str:
    scheme, _, token = request.headers.get("authorization", "").partition(" ")
    if scheme.casefold() != "bearer" or not token.strip():
        raise unavailable()
    return token


@router.post("/suggestions", response_model=RecipeSuggestionsResponse)
async def post_recipe_suggestions(
    payload: RecipeSuggestionRequest,
    _user_id: CurrentUserId,
    foods: FoodLineSource = Depends(get_food_line_source),
    provider: LLMProvider = Depends(get_recipe_provider),
    retriever: RecipeRetrieverPort = Depends(get_recipe_retriever),
) -> RecipeSuggestionsResponse:
    """Generate one authenticated, session-scoped batch of recipe suggestions.

    Reads the household's foods and kitchen basics as the caller, then runs
    the recipe graph. Responds 503 ``AI_UNAVAILABLE`` when they can't be read
    or generation fails.
    """
    if payload.batch_ceiling == 0:
        return RecipeSuggestionsResponse(
            data=RecipeSuggestionsData(recipes=[]),
        )

    deadline = PipelineDeadline.from_now(settings.ai_pipeline_budget_seconds)
    prompt = load_prompt("generate_recipes")

    try:
        lines, basics = await _within_recipe_deadline(
            deadline, lambda: _read_kitchen(foods, payload.household_id)
        )
        state = _initial_recipe_state(
            lines,
            kitchen_basics=basics,
            preferences=payload.preferences,
            exclude_titles=payload.exclude_titles,
            batch_ceiling=payload.batch_ceiling,
            deadline=deadline,
        )
        result = await _invoke_recipe_graph(
            build_recipe_graph(provider, retriever, prompt=prompt),
            state,
            prompt,
        )
        recipes = _build_suggestions(
            result,
            exclude_titles=payload.exclude_titles,
            batch_ceiling=payload.batch_ceiling,
        )
    except asyncio.CancelledError:
        raise
    except (ProviderError, TimeoutError, ValueError, FoodLinesError) as exc:
        raise _ai_unavailable() from exc

    return RecipeSuggestionsResponse(
        data=RecipeSuggestionsData(recipes=recipes),
    )


@router.post("/sessions", response_model=RecipeFeedResponse)
async def post_recipe_feed_session(
    payload: RecipeFeedSessionRequest,
    _user_id: CurrentUserId,
    store: RecipeFeedStore = Depends(get_recipe_feed_store),
    foods: FoodLineSource = Depends(get_food_line_source),
    provider: LLMProvider = Depends(get_recipe_provider),
    retriever: RecipeRetrieverPort = Depends(get_recipe_retriever),
    images: ImageService = Depends(get_image_service),
) -> RecipeFeedResponse:
    """Create a feed session and persist its first bounded candidate pool.

    Reads the household's foods and kitchen basics as the caller, and stores
    the basics on the session for later refills. The response holds only
    the batch's first ``BATCH_PHOTO_LIMIT`` recipes, each with its photo,
    which the pipeline generates and charges to the caller as soon as the
    recipe passes its review. The rest of the batch is stored without photos
    for the next page request. A missing photo never fails the request; its
    card carries a placeholder result. Responds 503
    ``RECIPE_FEED_UNAVAILABLE`` when they can't be read or the session can't
    be stored, and 503 ``AI_UNAVAILABLE`` when generation fails or the
    deadline runs out.
    """
    prompt = load_prompt("generate_recipes")
    deadline = PipelineDeadline.from_now(settings.recipe_feed_initial_budget_seconds)

    started_at = time.monotonic()
    try:
        lines, basics = await _within_recipe_deadline(
            deadline, lambda: _read_kitchen(foods, payload.household_id)
        )
        state = _initial_recipe_state(
            lines,
            kitchen_basics=basics,
            preferences=payload.preferences,
            exclude_titles=[],
            batch_ceiling=RECIPE_FEED_INITIAL_HEAD_BATCH_CEILING,
            deadline=deadline,
        )
        result = await _invoke_recipe_graph(
            build_recipe_graph(
                provider,
                retriever,
                prompt=prompt,
                quality_retry_limit=RECIPE_FEED_INITIAL_QUALITY_RETRY_LIMIT,
                retry_only_when_no_valid=RECIPE_FEED_INITIAL_RETRY_ONLY_WHEN_EMPTY,
                retrieval_limit=RECIPE_FEED_RETRIEVAL_POOL_LIMIT,
                photos=RequesterRecipePhotos(images, _user_id),
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
        recipes = _build_suggestions(
            result,
            exclude_titles=[],
            batch_ceiling=RECIPE_FEED_INITIAL_HEAD_BATCH_CEILING,
        )
        session = _session_from_initial_result(
            _user_id, payload.preferences, result, len(recipes)
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
        photos = result.get("recipe_photos", {})
        cards = await _feed_cards(
            _photographed(recipes, photos, images), photos, images, _user_id, deadline
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
    except (RecipeFeedStoreError, FoodLinesError) as exc:
        logger.warning(
            "Recipe feed session store failure after %.2fs: %s",
            time.monotonic() - started_at,
            exc,
        )
        raise _feed_unavailable() from exc

    return _feed_response(
        session,
        cards,
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
    provider: LLMProvider = Depends(get_recipe_provider),
    images: ImageService = Depends(get_image_service),
) -> RecipeFeedResponse:
    """Return a stable cursor page, refilling the pool only at its tail.

    A page returns the stored candidates from the cursor and generates the
    photo of any that has none, charged to the caller, before returning it,
    so every card arrives with its photo. Only a cursor at the end of the
    stored pool refills it: the request generates a batch, as the first
    session does, and returns the leading cards that have photos. When
    another request generated that batch, those are the cards whose photos
    it stored, so both requests return the same page.
    Responds 404 ``RECIPE_FEED_NOT_FOUND`` for another user's or an expired
    session, 422 ``RECIPE_FEED_INVALID_CURSOR`` for a cursor past the pool,
    503 ``AI_UNAVAILABLE`` when a refill fails, and 503
    ``RECIPE_FEED_UNAVAILABLE`` when the store can't be reached.
    """
    cursor = _parse_feed_cursor(payload.cursor)
    photos: Mapping[str, ImageResult] = {}
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
        photo_source = RequesterRecipePhotos(images, _user_id)
        refilled = not recipes and session.has_more
        if refilled:
            steering = await _within_recipe_deadline(
                deadline,
                lambda: resolve_steering(store, _user_id, session, payload.steering),
            )
            session, added, photos = await _refill_recipe_feed_session(
                session,
                _user_id,
                store,
                provider,
                photo_source,
                deadline,
                steering,
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
        photos = {
            **await _stored_photos(
                _without_photos(recipes, photos, images), images, _user_id, deadline
            ),
            **photos,
        }
        if refilled:
            recipes = _photographed(recipes, photos, images)
        else:
            photos = {
                **photos,
                **await photograph(
                    photo_source,
                    _without_photos(recipes, photos, images),
                    deadline=deadline,
                ),
            }
        cards = await _feed_cards(recipes, photos, images, _user_id, deadline)
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

    return _feed_response(session, cards, cursor=cursor)


class _RefillOutcome(NamedTuple):
    """What one refill attempt produced.

    Attributes:
        session: The session after the refill.
        added: Whether the pool grew.
        photos: Photos this request generated, by photo key.
    """

    session: RecipeFeedSession
    added: bool
    photos: Mapping[str, ImageResult]


async def _refill_recipe_feed_session(
    session: RecipeFeedSession,
    user_id: str,
    store: RecipeFeedStore,
    provider: LLMProvider,
    photo_source: RecipePhotoSource,
    deadline: PipelineDeadline,
    steering: RecipeSteering,
) -> _RefillOutcome:
    """Generate one tail batch using the session's cached retrieval context.

    A batch another request generated comes back with no photos, and the
    page reads the photos that request stored. That batch was generated
    without this request's ``steering``.
    """
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
        return _RefillOutcome(claimed, claimed.candidate_count > original_count, {})
    try:
        return await _generate_claimed_recipe_refill(
            claimed,
            user_id,
            store,
            provider,
            photo_source,
            deadline,
            claim_id,
            steering,
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
    provider: LLMProvider,
    photo_source: RecipePhotoSource,
    deadline: PipelineDeadline,
    claim_id: UUID,
    steering: RecipeSteering,
) -> _RefillOutcome:
    """Generate and finalize the batch owned by one database reservation."""
    prompt = load_prompt("generate_recipes")
    retrieval_window = session.retrieved_recipes[
        session.retrieval_cursor : session.retrieval_cursor + GENERATION_DOCS_CEILING
    ]
    state: RecipeState = {
        "preferences": session.preferences,
        "exclude_titles": session.exclude_titles,
        "batch_ceiling": RECIPE_FEED_REFILL_BATCH_CEILING,
        "usable_items": session.usable_items,
        "kitchen_basics": session.kitchen_basics,
        "retrieved_recipes": retrieval_window,
        "metadata": {},
        "deadline": deadline,
        "steering": steering,
    }
    result = await _invoke_recipe_graph(
        build_recipe_generation_graph(
            provider,
            prompt=prompt,
            quality_retry_limit=RECIPE_FEED_REFILL_QUALITY_RETRY_LIMIT,
            photos=photo_source,
        ),
        state,
        prompt,
    )
    generated = _build_suggestions(
        result,
        exclude_titles=session.exclude_titles,
        batch_ceiling=RECIPE_FEED_REFILL_BATCH_CEILING,
    )
    existing_titles = {title_key(title) for title in session.exclude_titles}
    recipes = [
        recipe
        for recipe in generated
        if title_key(recipe.title) not in existing_titles
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
    return _RefillOutcome(persisted, bool(recipes), result.get("recipe_photos", {}))


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


async def _read_kitchen(
    foods: FoodLineSource, household_id: UUID
) -> tuple[list[FoodLine], KitchenBasics]:
    lines, basic_names = await asyncio.gather(
        foods.list_food_lines(household_id), foods.list_kitchen_basics(household_id)
    )
    return lines, KitchenBasics(basic_names)


def _initial_recipe_state(
    lines: Sequence[FoodLine],
    *,
    kitchen_basics: KitchenBasics,
    preferences: dict[str, Any],
    exclude_titles: list[str],
    batch_ceiling: int,
    deadline: PipelineDeadline,
) -> RecipeState:
    return {
        "inventory": [line.model_dump(mode="python") for line in lines],
        "kitchen_basics": kitchen_basics,
        "preferences": preferences,
        "exclude_titles": exclude_titles,
        "batch_ceiling": batch_ceiling,
        "metadata": {},
        "deadline": deadline,
    }


def _session_from_initial_result(
    user_id: str,
    preferences: Mapping[str, Any],
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
        preferences=jsonable_encoder(preferences),
        usable_items=jsonable_encoder(list(usable_items)),
        retrieved_recipes=jsonable_encoder(list(retrieved_recipes)),
        retrieval_cursor=min(GENERATION_DOCS_CEILING, len(retrieved_recipes)),
        exclude_titles=[],
        kitchen_basics=result["kitchen_basics"],
        candidate_count=candidate_count,
        generation_runs=1,
        has_more=bool(usable_items),
    )


async def _feed_cards(
    recipes: Sequence[RecipeSuggestion],
    photos: Mapping[str, ImageResult],
    images: ImageService,
    user_id: str,
    deadline: PipelineDeadline,
) -> list[RecipeFeedCard]:
    """Attach each recipe's photo from `photos`, or else from the photo cache."""

    async def card(recipe: RecipeSuggestion) -> RecipeFeedCard:
        image = photos.get(images.recipe_key(recipe))
        if image is None:
            image = await _stored_photo(recipe, images, user_id, deadline)
        return RecipeFeedCard(**recipe.model_dump(), image=image)

    return list(await asyncio.gather(*(card(recipe) for recipe in recipes)))


async def _stored_photo(
    recipe: RecipeSuggestion,
    images: ImageService,
    user_id: str,
    deadline: PipelineDeadline,
) -> ImageResult | None:
    try:
        result = await _within_recipe_deadline(
            deadline,
            lambda: images.recipe_image(recipe, user_id, generate=False),
        )
    except (ImageStoreError, TimeoutError):
        return None
    return result if result.status == "ready" else None


def _without_photos(
    recipes: Sequence[RecipeSuggestion],
    photos: Mapping[str, ImageResult],
    images: ImageService,
) -> list[RecipeSuggestion]:
    return [recipe for recipe in recipes if images.recipe_key(recipe) not in photos]


async def _stored_photos(
    recipes: Sequence[RecipeSuggestion],
    images: ImageService,
    user_id: str,
    deadline: PipelineDeadline,
) -> dict[str, ImageResult]:
    """Return the ready stored photos of `recipes` by photo key, generating none."""
    found = await asyncio.gather(
        *(_stored_photo(recipe, images, user_id, deadline) for recipe in recipes)
    )
    return {photo.image_key: photo for photo in found if photo is not None}


def _photographed(
    recipes: Sequence[RecipeSuggestion],
    photos: Mapping[str, ImageResult],
    images: ImageService,
) -> list[RecipeSuggestion]:
    """Return the leading recipes that have a photo in `photos`.

    A batch photographs the recipes it lists first, so this is the part of
    a fresh batch a response can show at once.
    """
    return list(takewhile(lambda recipe: images.recipe_key(recipe) in photos, recipes))


def _feed_response(
    session: RecipeFeedSession,
    recipes: Sequence[RecipeFeedCard],
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
            requested_dish=requested_dish(session.preferences),
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
    *,
    exclude_titles: Sequence[str],
    batch_ceiling: int,
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

    basics: KitchenBasics = result["kitchen_basics"]
    excluded_titles = {
        title_key(title) for title in exclude_titles if title.strip()
    }
    suggestions: list[RecipeSuggestion] = []
    for raw_recipe in raw_recipes:
        recipe = Recipe.model_validate(raw_recipe)
        if title_key(recipe.title) in excluded_titles:
            continue
        suggestions.append(
            RecipeSuggestion(
                **recipe.model_dump(mode="python"),
                recipe_id=uuid4(),
                match_percent=ingredient_coverage_percent(
                    recipe, raw_inventory, basics
                ),
                saves_expiring=_expiring_item_names(recipe, raw_inventory),
            )
        )
        if len(suggestions) >= batch_ceiling:
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


def _unique_titles(titles: Sequence[str]) -> list[str]:
    seen: set[str] = set()
    unique: list[str] = []
    for title in titles:
        normalized = title_key(title)
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
