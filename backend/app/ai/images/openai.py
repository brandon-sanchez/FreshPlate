"""Small, single-attempt adapter for the GPT Image 2 HTTP API."""

from __future__ import annotations

import base64
import binascii
import json
from io import BytesIO
from typing import Any

import httpx
from PIL import Image, UnidentifiedImageError
from PIL.Image import DecompressionBombError
from pydantic import SecretStr

from app.ai.llm.errors import ProviderError

ENDPOINT = "https://api.openai.com/v1/images/generations"
MAX_PROMPT_BYTES = 8000
MAX_RESPONSE_BYTES = 10 * 1024 * 1024
MAX_ENVELOPE_BYTES = 14 * 1024 * 1024
MAX_IMAGE_DIMENSION = 4096
MODEL = "gpt-image-2"


class OpenAIImageProvider:
    """Generate one PNG image after a caller owns its reservation."""

    def __init__(
        self,
        api_key: SecretStr | str,
        *,
        enabled: bool = False,
        monthly_cap_microusd: int = 0,
        client: httpx.AsyncClient | None = None,
    ) -> None:
        self._api_key = (
            api_key.get_secret_value() if isinstance(api_key, SecretStr) else api_key
        )
        self._enabled = enabled
        self._monthly_cap_microusd = monthly_cap_microusd
        self._client = client

    async def generate(self, prompt: str, *, kind: str) -> bytes | None:
        if not self._enabled or not self._api_key or self._monthly_cap_microusd <= 0:
            return None
        if not prompt.strip():
            raise ValueError("Image prompt must not be blank")
        encoded = prompt.encode("utf-8")
        if len(encoded) > MAX_PROMPT_BYTES:
            raise ValueError("Image prompt exceeds 8000 UTF-8 bytes")
        payload: dict[str, Any] = {"model": MODEL, "prompt": prompt, "n": 1}
        if kind == "recipe":
            payload.update(size="1536x1024", quality="medium")
        elif kind == "ingredient":
            payload.update(size="1024x1024", quality="low")
        else:
            raise ValueError("Image kind must be recipe or ingredient")
        client = self._client or httpx.AsyncClient(follow_redirects=False)
        close_client = self._client is None
        response: httpx.Response | None = None
        try:
            request = client.build_request(
                "POST",
                ENDPOINT,
                headers={"Authorization": f"Bearer {self._api_key}"},
                json=payload,
                timeout=120.0,
            )
            response = await client.send(request, stream=True, follow_redirects=False)
            if response.status_code < 200 or response.status_code >= 300:
                raise ProviderError(
                    "Image provider unavailable", status_code=response.status_code
                )
            content_length = response.headers.get("content-length", "")
            if content_length.isdigit() and int(content_length) > MAX_ENVELOPE_BYTES:
                raise ProviderError("Image provider response is too large")
            chunks: list[bytes] = []
            total = 0
            async for chunk in response.aiter_bytes():
                total += len(chunk)
                if total > MAX_ENVELOPE_BYTES:
                    raise ProviderError("Image provider response is too large")
                chunks.append(chunk)
            await response.aclose()
            try:
                body = json.loads(b"".join(chunks))
            except (json.JSONDecodeError, UnicodeDecodeError) as exc:
                raise ProviderError(
                    "Image provider returned invalid JSON", cause=exc
                ) from exc
            data = body.get("data") if isinstance(body, dict) else None
            if not isinstance(data, list) or len(data) != 1:
                raise ProviderError("Image provider returned an invalid image")
            value = data[0].get("b64_json") if isinstance(data[0], dict) else None
            if not isinstance(value, str) or not value:
                raise ProviderError("Image provider returned an invalid image")
            try:
                image = base64.b64decode(value, validate=True)
            except (binascii.Error, ValueError) as exc:
                raise ProviderError(
                    "Image provider returned an invalid image", cause=exc
                ) from exc
            if len(image) > MAX_RESPONSE_BYTES:
                raise ProviderError("Image provider returned an invalid PNG")
            try:
                with Image.open(BytesIO(image), formats=("PNG",)) as decoded:
                    if max(decoded.size) > MAX_IMAGE_DIMENSION:
                        raise ProviderError("Image provider returned an oversized PNG")
                    decoded.verify()
                with Image.open(BytesIO(image), formats=("PNG",)) as decoded:
                    decoded.load()
            except (
                DecompressionBombError,
                SyntaxError,
                UnidentifiedImageError,
                OSError,
            ) as exc:
                raise ProviderError(
                    "Image provider returned an invalid PNG", cause=exc
                ) from exc
            return image
        except ProviderError:
            raise
        except (httpx.HTTPError, ValueError, TypeError) as exc:
            raise ProviderError("Image provider unavailable", cause=exc) from exc
        finally:
            if response is not None:
                await response.aclose()
            if close_client:
                await client.aclose()
