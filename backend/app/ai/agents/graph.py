"""LangGraph wiring for the recipe pipeline and its optional photos."""

from collections.abc import Callable, Mapping
from typing import Any

from langchain_core.runnables import RunnableConfig
from langgraph.graph import END, START, StateGraph

from app.ai.agents.meal_quality import review_recipe
from app.ai.agents.models import Recipe
from app.ai.agents.nodes import (
    MAX_QUALITY_RETRIES,
    RecipeRetrieverPort,
    analyze_inventory,
    generate_recipes,
    retrieve_recipes,
)
from app.ai.agents.photos import (
    PHOTO_RESERVE_SECONDS,
    BatchPhotos,
    RecipePhotoSource,
)
from app.ai.agents.state import (
    RecipeReview,
    RecipeState,
    RetrievalResult,
    WriteResult,
)
from app.ai.llm.protocol import LLMProvider
from app.ai.llm.retry import PipelineDeadline
from app.ai.prompts.loader import PromptTemplate, load_prompt
from app.ai.rag.vector_store import DEFAULT_MATCH_LIMIT


def build_recipe_graph(
    provider: LLMProvider,
    retriever: RecipeRetrieverPort,
    *,
    prompt: PromptTemplate | None = None,
    quality_retry_limit: int = MAX_QUALITY_RETRIES,
    retry_only_when_no_valid: bool = False,
    retrieval_limit: int = DEFAULT_MATCH_LIMIT,
    photos: RecipePhotoSource | None = None,
) -> Any:
    """Compile the recipe pipeline: analyze, retrieve, then write recipes.

    The write step reviews each recipe as its generation call returns and
    rewrites a rejected one alone, at most ``quality_retry_limit`` times.
    With ``retry_only_when_no_valid``, rejected recipes are rewritten only
    when the batch kept none. See ``generate_recipes``.

    ``retrieval_limit`` controls how many grounding docs the retrieve node
    fetches. Feed sessions request a pool larger than one generation window
    so later refill runs can draw on docs no earlier run has used.

    With ``photos``, the write step starts a recipe's photo as soon as the
    review keeps it, for the first ``BATCH_PHOTO_LIMIT`` recipes. Once those
    photos are done it stops waiting for slower recipes, which are dropped,
    and ``recipe_photos`` holds the photos by photo key. The recipe steps
    stop ``PHOTO_RESERVE_SECONDS`` before the state's deadline to leave the
    photos time. See ``BatchPhotos``.
    """
    _validate_quality_retry_limit(quality_retry_limit)
    template = prompt or load_prompt("generate_recipes")
    judge = load_prompt("assess_meals")
    builder = StateGraph(RecipeState)
    step_deadline = _recipe_steps_deadline(photos)

    async def analyze_node(
        state: RecipeState,
        config: RunnableConfig | None = None,
    ) -> dict[str, Any]:
        deadline = _deadline_for_state(state)
        metadata = _trace_metadata(state, config, template)
        return {
            **analyze_inventory(state),
            "deadline": deadline,
            "metadata": metadata,
        }

    async def retrieve_node(state: RecipeState) -> RetrievalResult:
        return await retrieve_recipes(
            state,
            retriever,
            limit=retrieval_limit,
            deadline=step_deadline(state),
        )

    async def write_node(state: RecipeState) -> WriteResult:
        return await _write_recipes(
            state,
            provider,
            template,
            judge,
            step_deadline(state),
            quality_retry_limit=quality_retry_limit,
            retry_only_when_no_valid=retry_only_when_no_valid,
            photos=photos,
        )

    builder.add_node("analyze_inventory", analyze_node)
    builder.add_node("retrieve_recipes", retrieve_node)
    builder.add_node("write_recipes", write_node)
    builder.add_edge(START, "analyze_inventory")
    builder.add_edge("analyze_inventory", "retrieve_recipes")
    builder.add_edge("retrieve_recipes", "write_recipes")
    builder.add_edge("write_recipes", END)
    return builder.compile()


def build_recipe_generation_graph(
    provider: LLMProvider,
    *,
    prompt: PromptTemplate | None = None,
    quality_retry_limit: int = MAX_QUALITY_RETRIES,
    retry_only_when_no_valid: bool = False,
    photos: RecipePhotoSource | None = None,
) -> Any:
    """Compile the write step alone, for an already-retrieved session.

    Feed refills reuse the first request's inventory analysis and retrieval
    context. This keeps later pages bounded to writing and reviewing recipes
    instead of re-embedding the same inventory for every scroll event.
    Retries and ``photos`` work as in ``build_recipe_graph``.
    """
    _validate_quality_retry_limit(quality_retry_limit)
    template = prompt or load_prompt("generate_recipes")
    judge = load_prompt("assess_meals")
    builder = StateGraph(RecipeState)
    step_deadline = _recipe_steps_deadline(photos)

    async def initialize_node(state: RecipeState) -> dict[str, Any]:
        return {"deadline": _deadline_for_state(state)}

    async def write_node(state: RecipeState) -> WriteResult:
        return await _write_recipes(
            state,
            provider,
            template,
            judge,
            step_deadline(state),
            quality_retry_limit=quality_retry_limit,
            retry_only_when_no_valid=retry_only_when_no_valid,
            photos=photos,
        )

    builder.add_node("initialize", initialize_node)
    builder.add_node("write_recipes", write_node)
    builder.add_edge(START, "initialize")
    builder.add_edge("initialize", "write_recipes")
    builder.add_edge("write_recipes", END)
    return builder.compile()


async def _write_recipes(
    state: RecipeState,
    provider: LLMProvider,
    template: PromptTemplate,
    judge: PromptTemplate,
    deadline: PipelineDeadline,
    *,
    quality_retry_limit: int,
    retry_only_when_no_valid: bool,
    photos: RecipePhotoSource | None,
) -> WriteResult:
    async def review(recipe: Recipe) -> RecipeReview:
        return await review_recipe(
            recipe, state, provider, prompt=judge, deadline=deadline
        )

    batch_photos = (
        None
        if photos is None
        else BatchPhotos(
            photos,
            exclude_titles=state.get("exclude_titles", []),
            deadline=_deadline_for_state(state),
        )
    )
    try:
        result = await generate_recipes(
            state,
            provider,
            prompt=template,
            deadline=deadline,
            review=review,
            quality_retry_limit=quality_retry_limit,
            retry_only_when_no_valid=retry_only_when_no_valid,
            on_kept=None if batch_photos is None else batch_photos.add,
            stop=None if batch_photos is None else batch_photos.done,
        )
    except BaseException:
        if batch_photos is not None:
            batch_photos.cancel()
        raise
    metadata = {
        **state.get("metadata", {}),
        "assessment_prompt_name": judge.name,
        "assessment_prompt_version": judge.version,
    }
    if batch_photos is None:
        return {**result, "metadata": metadata}
    return {
        **result,
        "metadata": metadata,
        "recipe_photos": await batch_photos.results(),
    }


def _recipe_steps_deadline(
    photos: RecipePhotoSource | None,
) -> Callable[[Mapping[str, Any]], PipelineDeadline]:
    if photos is None:
        return _deadline_for_state
    return lambda state: _deadline_for_state(state).ending_before(PHOTO_RESERVE_SECONDS)


def _validate_quality_retry_limit(value: int) -> None:
    if not isinstance(value, int) or isinstance(value, bool) or value < 0:
        raise ValueError("Quality retry limit must be a non-negative integer")


def _deadline_for_state(state: Mapping[str, Any]) -> PipelineDeadline:
    deadline = state.get("deadline")
    if deadline is None:
        return PipelineDeadline.from_now()
    if not isinstance(deadline, PipelineDeadline):
        raise ValueError("Recipe state deadline must be a PipelineDeadline")
    return deadline


def _trace_metadata(
    state: Mapping[str, Any],
    config: Mapping[str, Any] | None,
    prompt: PromptTemplate,
) -> dict[str, Any]:
    existing = state.get("metadata", {})
    metadata = dict(existing) if isinstance(existing, Mapping) else {}
    metadata.update(
        {
            "prompt_name": prompt.name,
            "prompt_version": prompt.version,
        }
    )
    if config is not None:
        trace_metadata = config.get("metadata")
        if isinstance(trace_metadata, Mapping):
            metadata.update(trace_metadata)
    return metadata
