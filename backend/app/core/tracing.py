"""Send queued LangSmith traces before each response leaves the API.

LangSmith uploads traces from a background thread. AWS Lambda freezes the
instance as soon as a response is returned, so an upload still queued then
would wait until the next request, or be lost when the instance is retired.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Callable
from typing import Any

from langsmith.run_trees import get_cached_client

logger = logging.getLogger("freshplate.tracing")

_FLUSH_TIMEOUT_SECONDS = 1.0


def flush_traces() -> None:
    """Upload every queued LangSmith trace, waiting up to one second.

    Blocks the calling thread. Traces still queued after the wait stay
    queued for the background uploader.
    """
    # LangGraph's tracer uploads through this cached client. The public
    # langchain_core.tracers.langchain.wait_for_all_tracers flushes the same
    # client but has no timeout.
    get_cached_client().flush(timeout=_FLUSH_TIMEOUT_SECONDS)


class TraceFlushMiddleware:
    """ASGI middleware that flushes traces before an HTTP response starts.

    The flush runs in a worker thread once the endpoint has finished, so
    every run the request traced is queued by then. A request that raises
    flushes before the exception propagates, because the server's error
    response is sent outside this middleware. A failed flush is logged and
    the response is still sent.
    """

    def __init__(self, app: Any, *, flush: Callable[[], None]) -> None:
        """Wrap ``app``.

        Args:
            app: The ASGI application to wrap.
            flush: Blocking call that uploads queued traces, such as
                `flush_traces`.
        """
        self._app = app
        self._flush = flush

    async def __call__(self, scope: dict, receive: Callable, send: Callable) -> None:
        """Handle one ASGI connection, flushing before an HTTP response."""
        if scope["type"] != "http":
            await self._app(scope, receive, send)
            return

        async def send_after_flush(message: dict) -> None:
            if message["type"] == "http.response.start":
                await self._flush_safely()
            await send(message)

        try:
            await self._app(scope, receive, send_after_flush)
        except Exception:
            await self._flush_safely()
            raise

    async def _flush_safely(self) -> None:
        try:
            await asyncio.to_thread(self._flush)
        except Exception as exc:
            logger.warning("trace flush failed error=%s", type(exc).__name__)
