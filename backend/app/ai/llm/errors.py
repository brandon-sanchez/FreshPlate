"""Errors shared by the language-model provider seam."""

from __future__ import annotations

from typing import ClassVar

AI_UNAVAILABLE = "AI_UNAVAILABLE"


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
    ) -> None:
        super().__init__(message)
        self.cause = cause
        self.status_code = status_code


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
