"""Run the credentialed Gemini provider smoke check.

Usage:
    cd backend
    venv/bin/python -m scripts.smoke_gemini

The script intentionally does not print or accept the API key on the command
line. The key is loaded through the normal settings environment.
"""

from __future__ import annotations

import asyncio
import time
from html.parser import HTMLParser

import httpx
from pydantic import BaseModel

from app.ai.llm.errors import AI_UNAVAILABLE, ProviderError
from app.ai.llm.providers import DEFAULT_GEMINI_MODEL, GeminiProvider
from app.core.config import settings

DEPRECATION_SCHEDULE_URL = "https://ai.google.dev/gemini-api/docs/deprecations"
SMOKE_LATENCY_BUDGET_SECONDS = 25.0


class SmokeResponse(BaseModel):
    message: str


class _DeprecationTableParser(HTMLParser):
    """Extract model rows from the official deprecation table."""

    def __init__(self) -> None:
        super().__init__()
        self.rows: list[tuple[str, str]] = []
        self._row_text: list[str] = []
        self._model_text: list[str] = []
        self._inside_row = False
        self._inside_model = False

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        del attrs
        if tag == "tr":
            self._inside_row = True
            self._row_text = []
            self._model_text = []
        elif tag == "code" and self._inside_row:
            self._inside_model = True

    def handle_data(self, data: str) -> None:
        if self._inside_row:
            self._row_text.append(data)
        if self._inside_model:
            self._model_text.append(data)

    def handle_endtag(self, tag: str) -> None:
        if tag == "code":
            self._inside_model = False
        elif tag == "tr" and self._inside_row:
            self.rows.append(
                (" ".join(self._model_text).strip(), " ".join(self._row_text).strip())
            )
            self._inside_row = False


def _assert_model_has_no_shutdown(html: str, model: str) -> None:
    parser = _DeprecationTableParser()
    parser.feed(html)
    for model_name, row_text in parser.rows:
        if model_name == model:
            if "No shutdown date announced" not in row_text:
                raise RuntimeError(f"{model} has a scheduled shutdown")
            return
    raise RuntimeError(f"{model} is missing from the deprecation schedule")


async def _verify_deprecation_schedule() -> None:
    async with httpx.AsyncClient(timeout=5.0) as client:
        response = await client.get(DEPRECATION_SCHEDULE_URL)
    response.raise_for_status()
    _assert_model_has_no_shutdown(response.text, DEFAULT_GEMINI_MODEL)


async def run_smoke_check() -> None:
    if not settings.gemini_api_key:
        raise SystemExit(
            "GEMINI_API_KEY is not configured. Set it in backend/.env for the "
            "live smoke check."
        )

    await _verify_deprecation_schedule()

    provider = GeminiProvider()
    started_at = time.monotonic()
    result = await provider.generate(
        "Return JSON with a concise message whose value is "
        '"FreshPlate provider is ready".',
        response_model=SmokeResponse,
    )
    latency_ms = (time.monotonic() - started_at) * 1000
    if not result.message.strip():
        raise RuntimeError("Gemini returned an empty structured message")
    if latency_ms > SMOKE_LATENCY_BUDGET_SECONDS * 1000:
        raise RuntimeError(
            f"Gemini smoke request exceeded {SMOKE_LATENCY_BUDGET_SECONDS:.0f}s budget"
        )

    invalid_key_error: ProviderError | None = None
    try:
        await GeminiProvider(api_key="invalid-smoke-test-key").generate(
            "Return a short JSON message.",
            response_model=SmokeResponse,
        )
    except ProviderError as exc:
        invalid_key_error = exc

    if invalid_key_error is None:
        raise RuntimeError("The invalid-key provider check unexpectedly succeeded")
    if invalid_key_error.code != AI_UNAVAILABLE:
        raise RuntimeError(
            f"Invalid-key check returned unexpected code: {invalid_key_error.code}"
        )

    print(f"model={DEFAULT_GEMINI_MODEL}")
    print(f"structured_output={result.model_dump_json()}")
    print(f"latency_ms={latency_ms:.0f}")
    print(f"invalid_key_error_code={AI_UNAVAILABLE}")
    print(f"deprecation_schedule=passed ({DEPRECATION_SCHEDULE_URL})")


if __name__ == "__main__":
    asyncio.run(run_smoke_check())
