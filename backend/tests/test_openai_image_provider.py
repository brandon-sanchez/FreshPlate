import base64
import json

import httpx
import pytest
from pydantic import SecretStr

from app.ai.images.openai import ENDPOINT, OpenAIImageProvider
from app.ai.llm.errors import ProviderError

PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
)


def client_for(handler):
    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


@pytest.mark.asyncio
async def test_generate_sends_fixed_recipe_parameters_and_png() -> None:
    seen = {}

    async def handler(request):
        seen.update(
            url=str(request.url),
            auth=request.headers["authorization"],
            body=json.loads(request.content),
        )
        return httpx.Response(
            200, json={"data": [{"b64_json": base64.b64encode(PNG).decode()}]}
        )

    async with client_for(handler) as client:
        result = await OpenAIImageProvider(
            SecretStr("key"), enabled=True, monthly_cap_microusd=1, client=client
        ).generate("meal", kind="recipe")
    assert result == PNG
    assert seen["url"] == ENDPOINT
    assert seen["auth"] == "Bearer key"
    assert seen["body"] == {
        "model": "gpt-image-2",
        "prompt": "meal",
        "n": 1,
        "size": "1536x1024",
        "quality": "medium",
    }


@pytest.mark.asyncio
async def test_generate_sends_ingredient_parameters() -> None:
    async def handler(request):
        body = json.loads(request.content)
        assert body["size"] == "1024x1024"
        assert body["quality"] == "low"
        return httpx.Response(
            200, json={"data": [{"b64_json": base64.b64encode(PNG).decode()}]}
        )

    async with client_for(handler) as client:
        result = await OpenAIImageProvider(
            "key", enabled=True, monthly_cap_microusd=1, client=client
        ).generate("ingredient", kind="ingredient")
    assert result == PNG


@pytest.mark.asyncio
async def test_disabled_or_empty_key_skips_http() -> None:
    async def handler(request):
        raise AssertionError("HTTP must not run")

    async with client_for(handler) as client:
        assert (
            await OpenAIImageProvider(
                SecretStr(""), enabled=True, client=client
            ).generate("x", kind="ingredient")
            is None
        )
        assert (
            await OpenAIImageProvider(
                SecretStr("key"), enabled=False, client=client
            ).generate("x", kind="ingredient")
            is None
        )
        assert (
            await OpenAIImageProvider(
                SecretStr("key"), enabled=True, monthly_cap_microusd=0, client=client
            ).generate("x", kind="ingredient")
            is None
        )


@pytest.mark.asyncio
async def test_oversize_prompt_and_provider_errors_are_single_attempt() -> None:
    calls = 0

    async def handler(request):
        nonlocal calls
        calls += 1
        return httpx.Response(429, text="secret provider body")

    async with client_for(handler) as client:
        provider = OpenAIImageProvider(
            "key", enabled=True, monthly_cap_microusd=1, client=client
        )
        with pytest.raises(ValueError):
            await provider.generate("é" * 4001, kind="ingredient")
        with pytest.raises(ProviderError) as error:
            await provider.generate("x", kind="ingredient")
    assert calls == 1
    assert "secret" not in str(error.value)
