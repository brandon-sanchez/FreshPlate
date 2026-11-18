"""Run a batch's recipe slots side by side, reviewing each recipe as it arrives.

A batch has one slot per recipe. Each slot makes its own generation call,
reviews the recipe as soon as that call returns, and on a rejection rewrites
only its own recipe with the rejection as feedback. No slot waits for
another, so a slow call holds back only its own recipe, and one bad recipe
never costs the batch its good ones.
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import Awaitable, Callable, Coroutine, Iterable, Sequence
from typing import Any, NamedTuple

from app.ai.agents.models import Recipe
from app.ai.agents.state import RecipeReview
from app.ai.llm.errors import ProviderError

logger = logging.getLogger("freshplate.ai.recipes")

SlotWriter = Callable[[str, str | None], Awaitable[Recipe | None]]
"""Make one generation call for a direction and optional retry feedback."""

SlotReviewer = Callable[[Recipe], Awaitable[RecipeReview]]
"""Review one generated recipe, raising ``ProviderError`` when it can't."""


class SlotOutcome(NamedTuple):
    """What one slot ended with.

    Attributes:
        written: The recipe each of the slot's calls wrote, rejected ones
            included.
        accepted: The recipe the slot keeps, or None.
        feedback: Why the slot's last recipe was rejected, or None.
        retries: How many times the slot rewrote its recipe.
        failure: The error that ended the slot, or None when every call
            answered.
    """

    written: list[Recipe]
    accepted: Recipe | None
    feedback: str | None
    retries: int
    failure: ProviderError | None


async def write_slots(
    directions: Sequence[str],
    *,
    write: SlotWriter,
    review: SlotReviewer | None,
    quality_retry_limit: int,
    retry_only_when_no_valid: bool,
    can_retry: Callable[[], bool],
    on_kept: Callable[[Recipe], None] | None = None,
    stop: asyncio.Event | None = None,
) -> list[SlotOutcome]:
    """Run one slot per direction at once and return their outcomes in order.

    Each slot writes a recipe, then reviews it as soon as its call returns.
    A rejected slot rewrites its recipe up to ``quality_retry_limit`` times,
    each time only while ``can_retry()`` says the deadline leaves room. With
    ``retry_only_when_no_valid``, no slot retries while the first round
    runs: rejected slots retry together afterwards, and only if no slot kept
    a recipe. With no reviewer, a slot keeps the recipe its call writes.
    Once ``stop`` is set, it cancels the slots still writing or reviewing,
    and they end with nothing kept.

    Args:
        directions: One prompt direction per slot.
        write: Makes one generation call. A call that returns no recipe is
            the model saying the kitchen can't make one for that direction.
        review: Reviews one recipe, or None to keep every recipe.
        quality_retry_limit: The most rewrites per slot. Zero never retries.
        retry_only_when_no_valid: Hold retries until the first round has
            kept nothing.
        can_retry: Whether enough time is left to start a rewrite.
        on_kept: Called with each kept recipe the moment its slot keeps it.
        stop: When set, ends the batch without waiting for slower slots.

    Returns:
        One outcome per direction, in the same order. A failed call ends
        only its own slot.
    """
    first_round_limit = 0 if retry_only_when_no_valid else quality_retry_limit
    kept = on_kept or (lambda _: None)
    outcomes = await _gather(
        (
            _run_slot(
                index, direction, write, review, first_round_limit, can_retry, kept
            )
            for index, direction in enumerate(directions)
        ),
        stop,
    )
    if (
        not retry_only_when_no_valid
        or quality_retry_limit == 0
        or any(outcome.accepted for outcome in outcomes)
        or not can_retry()
    ):
        return outcomes
    rejected = [
        index
        for index, outcome in enumerate(outcomes)
        if outcome.feedback is not None and outcome.failure is None
    ]
    resumed = await _gather(
        _run_slot(
            index,
            directions[index],
            write,
            review,
            quality_retry_limit,
            can_retry,
            kept,
            resume=outcomes[index],
        )
        for index in rejected
    )
    for index, outcome in zip(rejected, resumed, strict=True):
        outcomes[index] = outcome
    return outcomes


async def _gather(
    slots: Iterable[Coroutine[Any, Any, SlotOutcome]],
    stop: asyncio.Event | None = None,
) -> list[SlotOutcome]:
    """Await every slot, or until ``stop`` is set, then raise any bug.

    A slot turns a ``ProviderError`` into its outcome, so anything else is a
    bug. Waiting for every slot before raising leaves no slot running with
    nobody to read its result. A slot cut off by ``stop`` ends with an empty
    outcome.
    """
    tasks = [asyncio.create_task(slot) for slot in slots]
    stopped = asyncio.create_task((stop or asyncio.Event()).wait())
    try:
        await asyncio.wait(
            [asyncio.gather(*tasks, return_exceptions=True), stopped],
            return_when=asyncio.FIRST_COMPLETED,
        )
    finally:
        stopped.cancel()
        for task in tasks:
            task.cancel()
    results = await asyncio.gather(*tasks, return_exceptions=True)
    outcomes: list[SlotOutcome] = []
    for index, result in enumerate(results):
        if isinstance(result, asyncio.CancelledError) and stop and stop.is_set():
            logger.info("Recipe slot %s stopped before it finished", index + 1)
            outcomes.append(SlotOutcome([], None, None, 0, None))
        elif isinstance(result, BaseException):
            raise result
        else:
            outcomes.append(result)
    return outcomes


async def _run_slot(
    index: int,
    direction: str,
    write: SlotWriter,
    review: SlotReviewer | None,
    retry_limit: int,
    can_retry: Callable[[], bool],
    on_kept: Callable[[Recipe], None],
    *,
    resume: SlotOutcome | None = None,
) -> SlotOutcome:
    """Write and review one slot's recipe until it is kept or out of retries.

    With ``resume``, the slot continues from that rejected outcome with a
    rewrite, so its written recipes and retry count carry on.
    """
    written = [] if resume is None else list(resume.written)
    retries = 0 if resume is None else resume.retries + 1
    feedback = None if resume is None else resume.feedback
    while True:
        started = time.monotonic()
        try:
            recipe = await write(direction, feedback)
        except ProviderError as error:
            logger.warning("Recipe slot %s generation failed: %r", index + 1, error)
            _log_attempt(index, retries, started, None, "generation_failed")
            return SlotOutcome(written, None, feedback, retries, error)
        generated_at = time.monotonic()
        if recipe is None:
            _log_attempt(index, retries, started, None, "no_recipe")
            return SlotOutcome(written, None, None, retries, None)
        written.append(recipe)
        if review is None:
            _log_attempt(index, retries, started, None, "kept")
            on_kept(recipe)
            return SlotOutcome(written, recipe, None, retries, None)
        try:
            reviewed = await review(recipe)
        except ProviderError as error:
            logger.warning("Recipe slot %s review failed: %r", index + 1, error)
            _log_attempt(index, retries, started, generated_at, "review_failed")
            return SlotOutcome(written, None, feedback, retries, error)
        if reviewed.recipe is not None:
            _log_attempt(index, retries, started, generated_at, "kept")
            on_kept(reviewed.recipe)
            return SlotOutcome(written, reviewed.recipe, None, retries, None)
        feedback = reviewed.feedback
        _log_attempt(index, retries, started, generated_at, "rejected")
        if retries >= retry_limit or not can_retry():
            return SlotOutcome(written, None, feedback, retries, None)
        retries += 1


def _log_attempt(
    index: int,
    retry: int,
    started: float,
    generated_at: float | None,
    outcome: str,
) -> None:
    """Log one slot attempt's generation and review seconds.

    ``generated_at`` is None when the attempt never reached review.
    """
    finished = time.monotonic()
    generation_end = finished if generated_at is None else generated_at
    attempt = {
        "slot": index + 1,
        "retry": retry,
        "outcome": outcome,
        "generation_seconds": round(generation_end - started, 2),
        "review_seconds": (
            None if generated_at is None else round(finished - generated_at, 2)
        ),
    }
    logger.info(
        "Recipe slot %s",
        " ".join(f"{key}={value}" for key, value in attempt.items()),
        extra={"recipe_slot": attempt},
    )
