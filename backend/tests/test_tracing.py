import logging

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.core import tracing
from app.core.config import settings
from app.core.tracing import TraceFlushMiddleware
from app.main import create_app


def _app(events: list[str], *, fail: bool = False) -> FastAPI:
    app = FastAPI()

    @app.get("/work")
    async def work() -> dict:
        events.append("endpoint")
        if fail:
            raise RuntimeError("endpoint failed")
        return {"ok": True}

    return app


async def _call(app, events: list[str]) -> None:
    async def receive() -> dict:
        return {"type": "http.request", "body": b"", "more_body": False}

    async def send(message: dict) -> None:
        events.append(message["type"])

    scope = {
        "type": "http",
        "asgi": {"version": "3.0"},
        "http_version": "1.1",
        "method": "GET",
        "scheme": "http",
        "path": "/work",
        "raw_path": b"/work",
        "query_string": b"",
        "headers": [],
        "server": ("test", 80),
        "client": ("test", 1),
        "root_path": "",
    }
    await app(scope, receive, send)


@pytest.mark.asyncio
async def test_flushes_traces_after_the_endpoint_and_before_the_response() -> None:
    events: list[str] = []
    app = TraceFlushMiddleware(_app(events), flush=lambda: events.append("flush"))

    await _call(app, events)

    assert events == [
        "endpoint",
        "flush",
        "http.response.start",
        "http.response.body",
    ]


@pytest.mark.asyncio
async def test_sends_the_response_when_the_flush_fails(caplog) -> None:
    events: list[str] = []

    def failing_flush() -> None:
        raise ConnectionError("LangSmith is down")

    app = TraceFlushMiddleware(_app(events), flush=failing_flush)

    with caplog.at_level(logging.WARNING, logger="freshplate.tracing"):
        await _call(app, events)

    assert events[-2:] == ["http.response.start", "http.response.body"]
    assert "ConnectionError" in caplog.text


def test_flushes_traces_when_the_endpoint_raises() -> None:
    events: list[str] = []
    app = _app(events, fail=True)
    app.add_middleware(TraceFlushMiddleware, flush=lambda: events.append("flush"))

    with TestClient(app, raise_server_exceptions=False) as client:
        assert client.get("/work").status_code == 500

    assert events == ["endpoint", "flush"]


def test_flush_traces_returns_with_nothing_queued() -> None:
    tracing.flush_traces()


def test_app_flushes_traces_only_when_tracing_is_enabled(monkeypatch) -> None:
    flushes: list[int] = []
    monkeypatch.setattr(tracing, "flush_traces", lambda: flushes.append(1))

    monkeypatch.setattr(settings, "langsmith_tracing", False)
    with TestClient(create_app()) as client:
        assert client.get("/health").status_code == 200
    assert flushes == []

    monkeypatch.setattr(settings, "langsmith_tracing", True)
    with TestClient(create_app()) as client:
        assert client.get("/health").status_code == 200
    assert flushes == [1]
