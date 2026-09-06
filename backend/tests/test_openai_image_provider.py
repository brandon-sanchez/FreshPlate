import base64
import json
import struct
import zlib
from io import BytesIO

import httpx
import pytest
from PIL import Image
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


class ClosingStream(httpx.AsyncByteStream):
    def __init__(self, payload: bytes, *, fail: bool = False) -> None:
        self.payload = payload
        self.fail = fail
        self.closed = False

    async def __aiter__(self):
        yield self.payload
        if self.fail:
            raise httpx.ReadError("synthetic stream failure")

    async def aclose(self) -> None:
        self.closed = True


def envelope(image: bytes) -> bytes:
    return json.dumps(
        {"data": [{"b64_json": base64.b64encode(image).decode()}]}
    ).encode()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "status,headers,fail",
    [
        (429, {}, False),
        (302, {"location": "https://untrusted.invalid"}, False),
        (200, {"content-length": str(14 * 1024 * 1024 + 1)}, False),
        (200, {}, True),
    ],
)
async def test_stream_errors_close_response_and_make_one_request(
    status, headers, fail
) -> None:
    stream = ClosingStream(b"private", fail=fail)
    calls = 0

    async def handler(request):
        nonlocal calls
        calls += 1
        return httpx.Response(status, headers=headers, stream=stream)

    async with client_for(handler) as client:
        with pytest.raises(ProviderError):
            await OpenAIImageProvider(
                "key", enabled=True, monthly_cap_microusd=1, client=client
            ).generate("x", kind="recipe")
    assert stream.closed
    assert calls == 1


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "body",
    [b"not json", envelope(b"not base64"), json.dumps({"data": []}).encode()],
)
async def test_malformed_image_responses_are_rejected(body) -> None:
    async def handler(request):
        return httpx.Response(200, content=body)

    async with client_for(handler) as client:
        with pytest.raises(ProviderError):
            await OpenAIImageProvider(
                "key", enabled=True, monthly_cap_microusd=1, client=client
            ).generate("x", kind="recipe")


@pytest.mark.asyncio
@pytest.mark.parametrize("image", [b"\x89PNG\r\n\x1a\n", b"\xff\xd8\xff\xe0invalid"])
async def test_non_decodable_images_are_rejected(image) -> None:
    async def handler(request):
        return httpx.Response(200, content=envelope(image))

    async with client_for(handler) as client:
        with pytest.raises(ProviderError):
            await OpenAIImageProvider(
                "key", enabled=True, monthly_cap_microusd=1, client=client
            ).generate("x", kind="recipe")


@pytest.mark.asyncio
async def test_valid_jpeg_is_rejected() -> None:
    output = BytesIO()
    Image.new("RGB", (1, 1), "red").save(output, format="JPEG")

    async def handler(request):
        return httpx.Response(200, content=envelope(output.getvalue()))

    async with client_for(handler) as client:
        with pytest.raises(ProviderError):
            await OpenAIImageProvider(
                "key", enabled=True, monthly_cap_microusd=1, client=client
            ).generate("x", kind="recipe")


@pytest.mark.asyncio
async def test_valid_eight_mib_png_is_accepted() -> None:
    output = BytesIO()
    Image.new("RGB", (1, 1), "red").save(output, format="PNG")
    tiny = output.getvalue()
    text = b"Note\0" + b"x" * (8 * 1024 * 1024)
    chunk = struct.pack(">I", len(text)) + b"tEXt" + text
    chunk += struct.pack(">I", zlib.crc32(b"tEXt" + text))
    image = tiny[:33] + chunk + tiny[33:]

    async def handler(request):
        return httpx.Response(200, content=envelope(image))

    async with client_for(handler) as client:
        result = await OpenAIImageProvider(
            "key", enabled=True, monthly_cap_microusd=1, client=client
        ).generate("x", kind="recipe")
    assert result == image


@pytest.mark.asyncio
async def test_corrupt_png_crc_is_normalized_to_provider_error() -> None:
    corrupt = bytearray(PNG)
    idat = corrupt.index(b"IDAT")
    corrupt[idat + 5] ^= 1

    async def handler(request):
        return httpx.Response(200, content=envelope(bytes(corrupt)))

    async with client_for(handler) as client:
        with pytest.raises(ProviderError):
            await OpenAIImageProvider(
                "key", enabled=True, monthly_cap_microusd=1, client=client
            ).generate("x", kind="recipe")


@pytest.mark.asyncio
async def test_oversized_png_header_is_rejected_before_decode() -> None:
    width = height = 100_000
    ihdr = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    image = b"\x89PNG\r\n\x1a\n" + struct.pack(">I", len(ihdr)) + b"IHDR" + ihdr
    image += struct.pack(">I", zlib.crc32(b"IHDR" + ihdr))

    async def handler(request):
        return httpx.Response(200, content=envelope(image))

    async with client_for(handler) as client:
        with pytest.raises(ProviderError):
            await OpenAIImageProvider(
                "key", enabled=True, monthly_cap_microusd=1, client=client
            ).generate("x", kind="recipe")
