"""Behavior tests for the shared LLM retry and deadline seam."""

from __future__ import annotations

import asyncio

import httpx
import pytest

from app.ai.llm.errors import ProviderError
from app.ai.llm.retry import PipelineDeadline, RetryPolicy
from app.core.config import settings


class FakeClock:
    def __init__(self) -> None:
        self.value = 100.0

    def __call__(self) -> float:
        return self.value


def test_pipeline_deadline_uses_the_configured_budget(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    clock = FakeClock()
    monkeypatch.setattr(settings, "ai_pipeline_budget_seconds", 12.5)

    deadline = PipelineDeadline.from_now(clock=clock)

    assert deadline.remaining_seconds == 12.5


@pytest.mark.asyncio
async def test_retry_policy_retries_transient_failures_with_shared_deadline() -> None:
    clock = FakeClock()
    sleeps: list[float] = []
    seen_deadlines: list[PipelineDeadline] = []
    calls = 0

    async def sleep(delay: float) -> None:
        sleeps.append(delay)

    async def operation(deadline: PipelineDeadline) -> str:
        nonlocal calls
        calls += 1
        seen_deadlines.append(deadline)
        if calls == 1:
            raise ProviderError("rate limited", status_code=429)
        if calls == 2:
            raise TimeoutError("request timed out")
        return "ready"

    deadline = PipelineDeadline(25.0, clock=clock)
    policy = RetryPolicy(sleep=sleep, jitter_seconds=0.0)

    result = await policy.run(operation, deadline=deadline)

    assert result == "ready"
    assert calls == 3
    assert sleeps == [1.0, 2.0]
    assert seen_deadlines == [deadline] * 3


@pytest.mark.asyncio
async def test_retry_policy_honors_provider_retry_delay() -> None:
    sleeps: list[float] = []
    calls = 0

    async def sleep(delay: float) -> None:
        sleeps.append(delay)

    async def operation(deadline: PipelineDeadline) -> str:
        del deadline
        nonlocal calls
        calls += 1
        if calls == 1:
            raise ProviderError(
                "rate limited",
                status_code=429,
                retry_after_seconds=7.5,
            )
        return "ready"

    result = await RetryPolicy(
        max_attempts=2,
        backoff_seconds=(1.0,),
        jitter_seconds=0.0,
        sleep=sleep,
    ).run(operation, deadline=PipelineDeadline(25.0))

    assert result == "ready"
    assert sleeps == [7.5]


@pytest.mark.asyncio
async def test_retry_policy_can_defer_rate_limits_to_a_batch_loader() -> None:
    calls = 0

    async def sleep(delay: float) -> None:
        del delay

    async def operation(deadline: PipelineDeadline) -> None:
        del deadline
        nonlocal calls
        calls += 1
        raise ProviderError("rate limited", status_code=429)

    with pytest.raises(ProviderError) as error:
        await RetryPolicy(
            retry_rate_limits=False,
            sleep=sleep,
        ).run(operation, deadline=PipelineDeadline(25.0))

    assert error.value.status_code == 429
    assert calls == 1


@pytest.mark.asyncio
async def test_retry_policy_does_not_retry_bad_request() -> None:
    calls = 0
    sleeps: list[float] = []

    async def sleep(delay: float) -> None:
        sleeps.append(delay)

    async def operation(deadline: PipelineDeadline) -> None:
        del deadline
        nonlocal calls
        calls += 1
        raise ProviderError("invalid request", status_code=400)

    with pytest.raises(ProviderError) as error:
        await RetryPolicy(sleep=sleep, jitter_seconds=0.0).run(
            operation,
            deadline=PipelineDeadline(25.0),
        )

    assert error.value.status_code == 400
    assert calls == 1
    assert sleeps == []


@pytest.mark.asyncio
async def test_retry_policy_does_not_retry_bad_request_with_timeout_cause() -> None:
    calls = 0

    async def operation(deadline: PipelineDeadline) -> None:
        del deadline
        nonlocal calls
        calls += 1
        raise ProviderError(
            "invalid request",
            cause=TimeoutError("request timed out"),
            status_code=400,
        )

    with pytest.raises(ProviderError):
        await RetryPolicy(jitter_seconds=0.0).run(
            operation,
            deadline=PipelineDeadline(25.0),
        )

    assert calls == 1


@pytest.mark.asyncio
async def test_retry_policy_retries_http_status_error_from_response() -> None:
    calls = 0
    response = httpx.Response(
        503,
        request=httpx.Request("GET", "https://example.com"),
    )
    upstream_error = httpx.HTTPStatusError(
        "service unavailable",
        request=response.request,
        response=response,
    )

    async def operation(deadline: PipelineDeadline) -> str:
        del deadline
        nonlocal calls
        calls += 1
        if calls == 1:
            raise upstream_error
        return "ready"

    result = await RetryPolicy(
        max_attempts=2,
        backoff_seconds=(0.0,),
        jitter_seconds=0.0,
    ).run(operation, deadline=PipelineDeadline(25.0))

    assert result == "ready"
    assert calls == 2


@pytest.mark.asyncio
async def test_retry_policy_retries_any_five_hundred_status() -> None:
    calls = 0

    async def operation(deadline: PipelineDeadline) -> str:
        del deadline
        nonlocal calls
        calls += 1
        if calls == 1:
            raise ProviderError("upstream failure", status_code=599)
        return "ready"

    result = await RetryPolicy(
        max_attempts=2,
        backoff_seconds=(0.0,),
        jitter_seconds=0.0,
    ).run(operation, deadline=PipelineDeadline(25.0))

    assert result == "ready"
    assert calls == 2


@pytest.mark.asyncio
async def test_retry_policy_discards_success_after_deadline() -> None:
    clock = FakeClock()
    deadline = PipelineDeadline(2.5, clock=clock)

    async def operation(operation_deadline: PipelineDeadline) -> str:
        clock.value += operation_deadline.remaining_seconds
        return "ready"

    with pytest.raises(ProviderError) as error:
        await RetryPolicy(jitter_seconds=0.0).run(
            operation,
            deadline=deadline,
        )

    assert error.value.code == "AI_UNAVAILABLE"


@pytest.mark.asyncio
async def test_retry_policy_stops_before_starting_an_attempt_after_deadline() -> None:
    clock = FakeClock()
    calls = 0

    async def sleep(delay: float) -> None:
        clock.value += delay

    async def operation(deadline: PipelineDeadline) -> None:
        del deadline
        nonlocal calls
        calls += 1
        raise ProviderError("upstream unavailable", status_code=503)

    with pytest.raises(ProviderError) as error:
        await RetryPolicy(sleep=sleep, jitter_seconds=0.0).run(
            operation,
            deadline=PipelineDeadline(2.5, clock=clock),
        )

    assert error.value.code == "AI_UNAVAILABLE"
    assert calls == 2


@pytest.mark.asyncio
async def test_retry_policy_propagates_cancellation_without_another_attempt() -> None:
    calls = 0

    async def sleep(delay: float) -> None:
        del delay
        raise asyncio.CancelledError

    async def operation(deadline: PipelineDeadline) -> None:
        del deadline
        nonlocal calls
        calls += 1
        raise ProviderError("upstream unavailable", status_code=503)

    with pytest.raises(asyncio.CancelledError):
        await RetryPolicy(sleep=sleep, jitter_seconds=0.0).run(
            operation,
            deadline=PipelineDeadline(25.0),
        )

    assert calls == 1


@pytest.mark.asyncio
async def test_retry_policy_propagates_in_flight_cancellation() -> None:
    calls = 0

    async def operation(deadline: PipelineDeadline) -> None:
        del deadline
        nonlocal calls
        calls += 1
        raise asyncio.CancelledError

    with pytest.raises(asyncio.CancelledError):
        await RetryPolicy(jitter_seconds=0.0).run(
            operation,
            deadline=PipelineDeadline(25.0),
        )

    assert calls == 1
