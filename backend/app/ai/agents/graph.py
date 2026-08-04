"""LangGraph wiring for the four-node recipe pipeline."""

from collections.abc import Mapping
from typing import Any

from langchain_core.runnables import RunnableConfig
from langgraph.graph import END, START, StateGraph

from app.ai.agents.nodes import (
    RecipeProviderPort,
    RecipeRetrieverPort,
    analyze_inventory,
    check_quality,
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
from app.ai.llm.retry import PipelineDeadline
from app.ai.prompts.loader import PromptTemplate, load_prompt


def build_recipe_graph(
    provider: RecipeProviderPort,
    retriever: RecipeRetrieverPort,
    *,
    prompt: PromptTemplate | None = None,
) -> Any:
    """Compile the recipe pipeline with one conditional quality retry."""
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
            deadline=_deadline_for_state(state),
        )

    async def generate_node(state: RecipeState) -> GenerationResult:
        return await generate_recipes(
            state,
            provider,
            prompt=template,
            deadline=_deadline_for_state(state),
        )

    def quality_node(state: RecipeState) -> QualityResult:
        return check_quality(state)

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
        route_after_quality,
        {"retry": "generate_recipes", "finish": END},
    )
    return builder.compile()


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
