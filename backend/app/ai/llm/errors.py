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
