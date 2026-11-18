"""Count the Gemini calls and tokens an eval run spends."""

from __future__ import annotations

import logging
from collections.abc import Iterator, Mapping, Sequence
from contextlib import contextmanager
from typing import Any

from pydantic import BaseModel, ConfigDict

from app.ai.llm.providers import GEMINI_CALL_RECORD
from app.ai.llm.providers import logger as provider_logger


class ModelUsage(BaseModel):
    """Gemini calls for one response model, with their summed token counts.

    Attributes:
        response_model: The structured output the calls asked for, such as
            ``JudgeResult``. It tells generation, meal review and judge
            calls apart.
        calls: Calls made, failed ones included.
        failed_calls: Calls that returned an error. Their tokens log as
            zero.
        prompt_tokens, output_tokens, thinking_tokens: Token totals as
            Gemini reported them. Thinking tokens bill at the output rate.
    """

    model_config = ConfigDict(extra="forbid")

    response_model: str
    calls: int
    failed_calls: int
    prompt_tokens: int
    output_tokens: int
    thinking_tokens: int


class _CallRecorder(logging.Handler):
    def __init__(self) -> None:
        super().__init__(logging.INFO)
        self.calls: list[Mapping[str, Any]] = []

    def emit(self, record: logging.LogRecord) -> None:
        call = getattr(record, GEMINI_CALL_RECORD, None)
        if isinstance(call, Mapping):
            self.calls.append(call)


@contextmanager
def recorded_gemini_calls() -> Iterator[list[Mapping[str, Any]]]:
    """Collect the call records ``GeminiProvider`` logs inside the block.

    Yields:
        A list that fills with one mapping per Gemini call. Embedding calls
        are not included, because the embedding client logs no usage.
    """
    logger = provider_logger
    recorder = _CallRecorder()
    level = logger.level
    logger.addHandler(recorder)
    # The provider logs at INFO, which the default WARNING level drops
    # before any handler sees it.
    logger.setLevel(logging.INFO)
    try:
        yield recorder.calls
    finally:
        logger.removeHandler(recorder)
        logger.setLevel(level)


def summarize_calls(calls: Sequence[Mapping[str, Any]]) -> list[ModelUsage]:
    """Return one usage row per response model, sorted by name."""
    rows: dict[str, ModelUsage] = {}
    for call in calls:
        name = str(call["response_model"])
        row = rows.get(name) or ModelUsage(
            response_model=name,
            calls=0,
            failed_calls=0,
            prompt_tokens=0,
            output_tokens=0,
            thinking_tokens=0,
        )
        rows[name] = row.model_copy(
            update={
                "calls": row.calls + 1,
                "failed_calls": row.failed_calls + (call["outcome"] != "ok"),
                "prompt_tokens": row.prompt_tokens + call["prompt_tokens"],
                "output_tokens": row.output_tokens + call["output_tokens"],
                "thinking_tokens": row.thinking_tokens + call["thinking_tokens"],
            }
        )
    return [rows[name] for name in sorted(rows)]
