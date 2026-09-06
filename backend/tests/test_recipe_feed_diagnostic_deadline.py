"""Offline verification of the opt-in live diagnostic's request timeout."""

import asyncio
import time

import httpx
import pytest
from fastapi import FastAPI

from tests import test_recipe_feed_live_repro as diagnostic


@pytest.mark.asyncio
async def test_live_diagnostic_cancels_a_hanging_endpoint(monkeypatch) -> None:
    app = FastAPI()
    cancelled = asyncio.Event()

    @app.post("/hang")
    async def hang():
        try:
            await asyncio.Event().wait()
        finally:
            cancelled.set()

    monkeypatch.setattr(diagnostic, "CLIENT_TIMEOUT_S", 0.03)
    started = time.monotonic()
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://test",
    ) as client:
        with pytest.raises(TimeoutError):
            await diagnostic._post_with_deadline(client, "/hang")
    assert cancelled.is_set()
    assert time.monotonic() - started < 0.5
