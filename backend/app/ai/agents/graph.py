"""LangGraph wiring for the four-node recipe pipeline."""

from collections.abc import Mapping
from typing import Any

from langchain_core.runnables import RunnableConfig
from langgraph.graph import END, START, StateGraph

from app.ai.agents.meal_quality import review_recipes
from app.ai.agents.nodes import (
    MAX_QUALITY_RETRIES,
    RecipeRetrieverPort,
    analyze_inventory,
    generate_recipes,
    retrieve_recipes,
    route_after_quality,
)
from app.ai.agents.state import (
    GenerationResult,
    QualityResult,
    RecipeState,
    RetrievalResult,
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
) -> Any:
    """Compile the recipe pipeline with a bounded quality retry budget.

    ``retrieval_limit`` controls how many grounding docs the retrieve node
    fetches. Feed sessions request a pool larger than one generation window
    so later refill runs can draw on docs no earlier run has used.
    """
    _validate_quality_retry_limit(quality_retry_limit)
    template = prompt or load_prompt("generate_recipes")
    builder = StateGraph(RecipeState)

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
            deadline=_deadline_for_state(state),
        )

    async def generate_node(state: RecipeState) -> GenerationResult:
        return await generate_recipes(
            state,
            provider,
            prompt=template,
            deadline=_deadline_for_state(state),
        )

    async def quality_node(state: RecipeState) -> QualityResult:
        return await review_recipes(
            state, provider, deadline=_deadline_for_state(state)
        )

    def quality_route(state: RecipeState) -> str:
        return route_after_quality(
            state,
            quality_retry_limit=quality_retry_limit,
            retry_only_when_no_valid=retry_only_when_no_valid,
        )

    builder.add_node("analyze_inventory", analyze_node)
    builder.add_node("retrieve_recipes", retrieve_node)
    builder.add_node("generate_recipes", generate_node)
    builder.add_node("check_quality", quality_node)
    builder.add_edge(START, "analyze_inventory")
    builder.add_edge("analyze_inventory", "retrieve_recipes")
    builder.add_edge("retrieve_recipes", "generate_recipes")
    builder.add_edge("generate_recipes", "check_quality")
    builder.add_conditional_edges(
        "check_quality",
        quality_route,
        {"retry": "generate_recipes", "finish": END},
    )
    return builder.compile()


def build_recipe_generation_graph(
    provider: LLMProvider,
    *,
    prompt: PromptTemplate | None = None,
    quality_retry_limit: int = MAX_QUALITY_RETRIES,
    retry_only_when_no_valid: bool = False,
) -> Any:
    """Compile generation and quality nodes for an already-retrieved session.

    Feed refills reuse the first request's inventory analysis and retrieval
    context. This keeps later pages bounded to generation and quality checks
    instead of re-embedding the same inventory for every scroll event.
    """
    _validate_quality_retry_limit(quality_retry_limit)
    template = prompt or load_prompt("generate_recipes")
    builder = StateGraph(RecipeState)

    async def initialize_node(state: RecipeState) -> dict[str, Any]:
        return {"deadline": _deadline_for_state(state)}

    async def generate_node(state: RecipeState) -> GenerationResult:
        return await generate_recipes(
            state,
            provider,
            prompt=template,
            deadline=_deadline_for_state(state),
        )

    async def quality_node(state: RecipeState) -> QualityResult:
        return await review_recipes(
            state, provider, deadline=_deadline_for_state(state)
        )

    def quality_route(state: RecipeState) -> str:
        return route_after_quality(
            state,
            quality_retry_limit=quality_retry_limit,
            retry_only_when_no_valid=retry_only_when_no_valid,
        )

    builder.add_node("generate_recipes", generate_node)
    builder.add_node("initialize", initialize_node)
    builder.add_node("check_quality", quality_node)
    builder.add_edge(START, "initialize")
    builder.add_edge("initialize", "generate_recipes")
    builder.add_edge("generate_recipes", "check_quality")
    builder.add_conditional_edges(
        "check_quality",
        quality_route,
        {"retry": "generate_recipes", "finish": END},
    )
    return builder.compile()


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
