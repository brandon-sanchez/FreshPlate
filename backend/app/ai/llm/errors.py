"""Errors shared by the language-model provider seam."""

from __future__ import annotations

import math
import re
from collections.abc import Mapping
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from typing import ClassVar

AI_UNAVAILABLE = "AI_UNAVAILABLE"
_RETRY_DURATION_PATTERN = re.compile(
    r"^(?P<value>[0-9]+(?:\.[0-9]+)?)(?P<unit>ns|us|µs|ms|s|m|h)$"
)


def retry_after_seconds_from_error(error: BaseException | None) -> float | None:
    """Extract a provider-directed retry delay without coupling to an SDK."""
    if error is None:
        return None

    response = getattr(error, "response", None)
    headers = getattr(response, "headers", None)
    if headers is not None:
        retry_after = _parse_retry_after_header(headers.get("retry-after"))
        if retry_after is not None:
            return retry_after

    return _find_retry_delay(getattr(error, "details", None))


def _parse_retry_after_header(value: object) -> float | None:
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return _finite_non_negative(float(value))
    if not isinstance(value, str) or not value.strip():
        return None

    try:
        return _finite_non_negative(float(value))
    except ValueError:
        pass

    try:
        retry_at = parsedate_to_datetime(value)
    except (TypeError, ValueError, OverflowError):
        return None
    if retry_at.tzinfo is None:
        retry_at = retry_at.replace(tzinfo=timezone.utc)
    return _finite_non_negative((retry_at - datetime.now(timezone.utc)).total_seconds())


def _find_retry_delay(value: object) -> float | None:
    if isinstance(value, Mapping):
        for key in ("retryDelay", "retry_delay"):
            delay = _parse_retry_duration(value.get(key))
            if delay is not None:
                return delay
        for nested in value.values():
            delay = _find_retry_delay(nested)
            if delay is not None:
                return delay
    elif isinstance(value, list):
        for nested in value:
            delay = _find_retry_delay(nested)
            if delay is not None:
                return delay
    return None


def _parse_retry_duration(value: object) -> float | None:
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return _finite_non_negative(float(value))
    if not isinstance(value, str):
        return None

    match = _RETRY_DURATION_PATTERN.fullmatch(value.strip())
    if match is None:
        return None
    multiplier = {
        "ns": 1e-9,
        "us": 1e-6,
        "µs": 1e-6,
        "ms": 1e-3,
        "s": 1.0,
        "m": 60.0,
        "h": 3600.0,
    }[match.group("unit")]
    return _finite_non_negative(float(match.group("value")) * multiplier)


def _finite_non_negative(value: float) -> float | None:
    if math.isfinite(value) and value >= 0:
        return value
    return None


class ProviderError(RuntimeError):
    """A provider failure that callers can expose as ``AI_UNAVAILABLE``.

    The original exception is retained for the retry layer and diagnostic logs,
    while the public message stays safe to return to an API caller.
    """

    code: ClassVar[str] = AI_UNAVAILABLE

    def __init__(
        self,
        message: str,
        *,
        cause: BaseException | None = None,
        status_code: int | None = None,
        retry_after_seconds: float | None = None,
    ) -> None:
        if retry_after_seconds is not None and (
            not math.isfinite(retry_after_seconds) or retry_after_seconds < 0
        ):
            raise ValueError("Retry delay must be finite and non-negative")
        super().__init__(message)
        self.cause = cause
        self.status_code = status_code
        self.retry_after_seconds = retry_after_seconds


def status_code_from_error(error: BaseException | None) -> int | None:
    """Extract a numeric status from an SDK or HTTP client exception."""
    if error is None:
        return None

    for attribute in ("status_code", "code"):
        value = getattr(error, attribute, None)
        if isinstance(value, int) and not isinstance(value, bool):
            return value

    response = getattr(error, "response", None)
    value = getattr(response, "status_code", None)
    if isinstance(value, int) and not isinstance(value, bool):
        return value
    return None
