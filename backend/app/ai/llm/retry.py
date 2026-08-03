"""Shared retry and monotonic deadline primitives for LLM calls."""

from __future__ import annotations

import asyncio
import math
import random
import time
from collections.abc import Awaitable, Callable, Sequence
from typing import TypeVar

import httpx

from app.ai.llm.errors import ProviderError, status_code_from_error
from app.core.config import settings

Response = TypeVar("Response")
Clock = Callable[[], float]
Sleep = Callable[[float], Awaitable[None]]
RandomUniform = Callable[[float, float], float]
Operation = Callable[["PipelineDeadline"], Awaitable[Response]]

DEFAULT_RETRY_DELAYS_SECONDS = (1.0, 2.0, 4.0)
# The default uses three total attempts; the next interval remains available
# when a caller explicitly opts into a fourth attempt.
DEFAULT_RETRY_ATTEMPTS = 3
DEFAULT_JITTER_SECONDS = 0.25
RETRYABLE_STATUS_CODES = frozenset({429})


class PipelineDeadline:
    """A fixed monotonic deadline shared by every pipeline operation."""

    __slots__ = ("_clock", "_deadline_at")

    def __init__(
        self,
        budget_seconds: float,
        *,
        clock: Clock = time.monotonic,
    ) -> None:
        if not math.isfinite(budget_seconds) or budget_seconds <= 0:
            raise ValueError("Pipeline deadline budget must be greater than zero")

        self._clock = clock
        self._deadline_at = clock() + budget_seconds

    @classmethod
    def from_now(
        cls,
        budget_seconds: float | None = None,
        *,
        clock: Clock = time.monotonic,
    ) -> "PipelineDeadline":
        """Start a deadline using the configured server budget."""
        configured_budget = (
            settings.ai_pipeline_budget_seconds
            if budget_seconds is None
            else budget_seconds
        )
        return cls(configured_budget, clock=clock)

    @property
    def expired(self) -> bool:
        """Return whether no time remains for another operation."""
        return self.remaining_seconds <= 0

    @property
    def remaining_seconds(self) -> float:
        """Return the non-negative number of seconds left in the budget."""
        return max(0.0, self._deadline_at - self._clock())

    @property
    def remaining_milliseconds(self) -> int:
        """Return remaining time rounded up for SDK timeout configuration."""
        remaining = self.remaining_seconds
        if remaining <= 0:
            return 0
        return max(1, math.ceil(remaining * 1000))


class RetryPolicy:
    """Retry transient provider failures without owning the pipeline budget."""

    def __init__(
        self,
        *,
        max_attempts: int = DEFAULT_RETRY_ATTEMPTS,
        backoff_seconds: Sequence[float] = DEFAULT_RETRY_DELAYS_SECONDS,
        jitter_seconds: float = DEFAULT_JITTER_SECONDS,
        sleep: Sleep | None = None,
        random_uniform: RandomUniform = random.uniform,
        retry_rate_limits: bool = True,
    ) -> None:
        if max_attempts < 1:
            raise ValueError("Retry policy must allow at least one attempt")

        delays = tuple(backoff_seconds)
        if len(delays) < max_attempts - 1:
            raise ValueError("Retry policy needs one delay for each retry")
        if any(not math.isfinite(delay) or delay < 0 for delay in delays):
            raise ValueError("Retry delays must be finite and non-negative")
        if not math.isfinite(jitter_seconds) or jitter_seconds < 0:
            raise ValueError("Retry jitter must be finite and non-negative")

        self._max_attempts = max_attempts
        self._backoff_seconds = delays
        self._jitter_seconds = jitter_seconds
        self._sleep = sleep
        self._random_uniform = random_uniform
        self._retry_rate_limits = retry_rate_limits

    async def run(
        self,
        operation: Operation[Response],
        *,
        deadline: PipelineDeadline,
    ) -> Response:
        """Run an operation until it succeeds, is non-retryable, or times out."""
        last_failure: ProviderError | None = None

        for attempt in range(self._max_attempts):
            remaining = deadline.remaining_seconds
            if remaining <= 0:
                raise _deadline_error(last_failure) from last_failure

            try:
                result = await asyncio.wait_for(operation(deadline), timeout=remaining)
                if deadline.expired:
                    raise _deadline_error(last_failure) from last_failure
                return result
            except asyncio.CancelledError:
                raise
            except ProviderError as exc:
                failure = exc
            except (TimeoutError, httpx.TimeoutException) as exc:
                failure = ProviderError("LLM operation timed out", cause=exc)
            except Exception as exc:
                failure = ProviderError(
                    "LLM operation failed",
                    cause=exc,
                    status_code=status_code_from_error(exc),
                )

            if not self._retry_rate_limits and _status_code_from_error(failure) == 429:
                raise failure
            if not _is_retryable(failure):
                raise failure

            last_failure = failure
            if attempt == self._max_attempts - 1:
                raise failure

            delay = self._backoff_seconds[attempt]
            if self._jitter_seconds:
                delay += self._random_uniform(0.0, self._jitter_seconds)
            if failure.retry_after_seconds is not None:
                delay = max(delay, failure.retry_after_seconds)
            if deadline.remaining_seconds <= delay:
                raise _deadline_error(failure) from failure

            await (self._sleep or asyncio.sleep)(delay)

        raise AssertionError("Retry policy loop completed without a result")


def _is_retryable(error: ProviderError) -> bool:
    """Return whether a provider error represents a transient failure."""
    status_code = _status_code_from_error(error)
    if status_code is not None:
        return _is_retryable_status(status_code)

    cause = error.cause
    while cause is not None:
        status_code = status_code_from_error(cause)
        if status_code is not None:
            return _is_retryable_status(status_code)
        if isinstance(cause, (TimeoutError, httpx.TimeoutException)):
            return True
        cause = cause.__cause__ or getattr(cause, "cause", None)
    return False


def _status_code_from_error(error: ProviderError) -> int | None:
    status_code = error.status_code
    if status_code is not None:
        return status_code

    cause = error.cause
    while cause is not None:
        status_code = status_code_from_error(cause)
        if status_code is not None:
            return status_code
        cause = cause.__cause__ or getattr(cause, "cause", None)
    return None


def _is_retryable_status(status_code: int) -> bool:
    """Retry rate limits and every server-side HTTP failure."""
    return status_code in RETRYABLE_STATUS_CODES or 500 <= status_code < 600


def _deadline_error(cause: ProviderError | None) -> ProviderError:
    """Build the safe public error used when the shared budget is exhausted."""
    return ProviderError("LLM pipeline deadline exhausted", cause=cause)
