"""LangGraph-compatible trace metadata without a runtime tracing client."""

from __future__ import annotations

from typing import TypedDict

from app.ai.prompts.loader import PromptTemplate


class TraceMetadata(TypedDict):
    """Metadata required to identify the prompt and originating request."""

    prompt_name: str
    prompt_version: str | int
    request_id: str


class TraceConfig(TypedDict):
    """The small config shape accepted by LangGraph invocation methods."""

    metadata: TraceMetadata


def build_trace_config(prompt: PromptTemplate, *, request_id: str) -> TraceConfig:
    """Build metadata for a traced graph invocation.

    LangGraph's native LangSmith integration reads ``LANGSMITH_*`` environment
    variables. Keeping this helper pure avoids a client, callback, or network
    dependency in the request path, so a tracing outage cannot fail generation.
    """
    if not request_id.strip():
        raise ValueError("request_id must not be empty")

    return {
        "metadata": {
            "prompt_name": prompt.name,
            "prompt_version": prompt.version,
            "request_id": request_id,
        }
    }
