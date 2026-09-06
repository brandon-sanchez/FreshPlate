"""Tests for the barcode lookup endpoint and service."""

from __future__ import annotations

from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient

from app.services import barcode_service
from tests.conftest import SigningKey


@pytest.fixture(autouse=True)
def _reset_cache() -> None:
    """Every test starts with an empty cache so they don't bleed into each other."""
    barcode_service._reset_cache_for_tests()


def _auth_headers(signing_key: SigningKey) -> dict[str, str]:
    return {"Authorization": f"Bearer {signing_key.sign()}"}


class _FakeResponse:
    """Stands in for httpx.Response — we only need status_code + .json()."""

    def __init__(self, status_code: int, payload: Any) -> None:
        self.status_code = status_code
        self._payload = payload

    def json(self) -> Any:
        if isinstance(self._payload, Exception):
            raise self._payload
        return self._payload


def _install_fake_off(
    monkeypatch: pytest.MonkeyPatch,
    *,
    response: _FakeResponse | None = None,
    raise_exc: Exception | None = None,
) -> dict[str, int]:
    """Patch `httpx.AsyncClient.get` inside the barcode service.

    Returns a counter dict whose 'count' increments on each call so cache tests
    can assert OFF was hit only N times.
    """
    counter = {"count": 0}

    async def fake_get(self, url, headers=None, params=None):  # type: ignore[no-untyped-def]
        counter["count"] += 1
        if raise_exc is not None:
            raise raise_exc
        assert response is not None
        return response

    monkeypatch.setattr(httpx.AsyncClient, "get", fake_get)
    return counter


_VALID_BARCODE = "3017620422003"  # Nutella, real OFF entry
_UNKNOWN_BARCODE = "9999999999993"


def _off_hit_payload() -> dict[str, Any]:
    return {
        "status": 1,
        "code": _VALID_BARCODE,
        "product": {
            "product_name": "Nutella",
            "brands": "Ferrero,Nutella",
            "quantity": "400 g",
            "categories_tags": [
                "en:breakfasts",
                "en:spreads",
                "en:sweet-spreads",
            ],
            "image_url": "https://images.openfoodfacts.org/nutella.jpg",
        },
    }


def _off_miss_payload() -> dict[str, Any]:
    return {
        "status": 0,
        "code": _UNKNOWN_BARCODE,
        "status_verbose": "product not found",
    }


def test_happy_path_returns_product(
    client: TestClient,
    signing_key: SigningKey,
    patch_jwks,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    patch_jwks([signing_key])
    _install_fake_off(monkeypatch, response=_FakeResponse(200, _off_hit_payload()))

    response = client.post(
        "/api/barcode/lookup",
        headers=_auth_headers(signing_key),
        json={"barcode": _VALID_BARCODE},
    )

    assert response.status_code == 200
    body = response.json()
    assert body["data"] is not None
    product = body["data"]
    assert product["barcode"] == _VALID_BARCODE
    assert product["name"] == "Nutella"
    # First-brand extraction: "Ferrero,Nutella" -> "Ferrero".
    assert product["brand"] == "Ferrero"
    assert product["quantity"] == "400 g"
    # Tag prefix stripped, lowercased.
    assert product["categories"] == ["breakfasts", "spreads", "sweet-spreads"]
    assert product["image_url"] == "https://images.openfoodfacts.org/nutella.jpg"


def test_not_found_returns_data_null_with_200(
    client: TestClient,
    signing_key: SigningKey,
    patch_jwks,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    patch_jwks([signing_key])
    _install_fake_off(monkeypatch, response=_FakeResponse(404, _off_miss_payload()))

    response = client.post(
        "/api/barcode/lookup",
        headers=_auth_headers(signing_key),
        json={"barcode": _UNKNOWN_BARCODE},
    )

    assert response.status_code == 200
    assert response.json() == {"data": None}


def test_missing_auth_returns_401(
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Even without patching OFF, no auth means we should never reach the service.
    counter = _install_fake_off(
        monkeypatch, response=_FakeResponse(200, _off_hit_payload())
    )

    response = client.post("/api/barcode/lookup", json={"barcode": _VALID_BARCODE})

    assert response.status_code == 401
    assert response.json()["code"] == "AUTH_MISSING_TOKEN"
    assert counter["count"] == 0  # never touched OFF


@pytest.mark.parametrize(
    "bad_barcode",
    [
        "",
        "1234567",  # 7 digits — too short
        "123456789012345",  # 15 digits — too long
        "12345abc",  # non-numeric
        "1234 5678",  # contains space
    ],
)
def test_invalid_barcode_format_returns_422(
    client: TestClient,
    signing_key: SigningKey,
    patch_jwks,
    bad_barcode: str,
) -> None:
    patch_jwks([signing_key])
    response = client.post(
        "/api/barcode/lookup",
        headers=_auth_headers(signing_key),
        json={"barcode": bad_barcode},
    )
    assert response.status_code == 422


def test_cache_hit_skips_off_on_second_call(
    client: TestClient,
    signing_key: SigningKey,
    patch_jwks,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    patch_jwks([signing_key])
    counter = _install_fake_off(
        monkeypatch, response=_FakeResponse(200, _off_hit_payload())
    )

    headers = _auth_headers(signing_key)
    body = {"barcode": _VALID_BARCODE}

    r1 = client.post("/api/barcode/lookup", headers=headers, json=body)
    r2 = client.post("/api/barcode/lookup", headers=headers, json=body)

    assert r1.status_code == 200
    assert r2.status_code == 200
    assert r1.json() == r2.json()
    assert counter["count"] == 1  # second call served from cache


def test_negative_cache_skips_off_on_second_miss(
    client: TestClient,
    signing_key: SigningKey,
    patch_jwks,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """An unknown barcode is cached as None — the second scan must NOT hit OFF."""
    patch_jwks([signing_key])
    counter = _install_fake_off(
        monkeypatch, response=_FakeResponse(404, _off_miss_payload())
    )

    headers = _auth_headers(signing_key)
    body = {"barcode": _UNKNOWN_BARCODE}

    r1 = client.post("/api/barcode/lookup", headers=headers, json=body)
    r2 = client.post("/api/barcode/lookup", headers=headers, json=body)

    assert r1.status_code == 200
    assert r2.status_code == 200
    assert r1.json() == {"data": None}
    assert r2.json() == {"data": None}
    assert counter["count"] == 1


def test_off_timeout_returns_502(
    client: TestClient,
    signing_key: SigningKey,
    patch_jwks,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    patch_jwks([signing_key])
    _install_fake_off(monkeypatch, raise_exc=httpx.ReadTimeout("OFF timed out"))

    response = client.post(
        "/api/barcode/lookup",
        headers=_auth_headers(signing_key),
        json={"barcode": _VALID_BARCODE},
    )

    assert response.status_code == 502
    body = response.json()
    assert body == {
        "error": "Barcode lookup service unavailable",
        "code": "BARCODE_LOOKUP_UPSTREAM_ERROR",
    }


def test_off_5xx_returns_502(
    client: TestClient,
    signing_key: SigningKey,
    patch_jwks,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    patch_jwks([signing_key])
    _install_fake_off(monkeypatch, response=_FakeResponse(503, {}))

    response = client.post(
        "/api/barcode/lookup",
        headers=_auth_headers(signing_key),
        json={"barcode": _VALID_BARCODE},
    )

    assert response.status_code == 502
    assert response.json()["code"] == "BARCODE_LOOKUP_UPSTREAM_ERROR"
