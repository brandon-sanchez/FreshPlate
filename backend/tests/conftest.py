"""Test fixtures: signing keypair, JWKS mocking, token factory, TestClient.

We mint EC P-256 keys (ES256), expose them via a fake JWKS that monkey-patches
`app.core.auth._fetch_jwks`, and sign tokens locally with python-jose. No
network calls are made during tests.
"""

from __future__ import annotations

import base64
import time
from collections.abc import Callable, Iterator
from typing import Any

import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec
from fastapi.testclient import TestClient
from jose import jwt

from app.core import auth as auth_module
from app.main import create_app


def _b64url_uint(value: int, byte_length: int) -> str:
    """Encode an EC coordinate as base64url with no padding (RFC 7518)."""
    raw = value.to_bytes(byte_length, "big")
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def _jwk_from_ec_private(
    key: ec.EllipticCurvePrivateKey, kid: str
) -> dict[str, Any]:
    """Build the public-half JWK (what JWKS would publish)."""
    public_numbers = key.public_key().public_numbers()
    return {
        "kty": "EC",
        "crv": "P-256",
        "alg": "ES256",
        "use": "sig",
        "kid": kid,
        "x": _b64url_uint(public_numbers.x, 32),
        "y": _b64url_uint(public_numbers.y, 32),
    }


def _ec_pem(key: ec.EllipticCurvePrivateKey) -> str:
    return key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    ).decode("ascii")


class SigningKey:
    """Bundle of a private EC key + matching kid + JWK form for tests."""

    def __init__(self, kid: str) -> None:
        self.kid = kid
        self._private = ec.generate_private_key(ec.SECP256R1())
        self.pem = _ec_pem(self._private)
        self.jwk = _jwk_from_ec_private(self._private, kid)

    def sign(
        self,
        *,
        sub: str = "00000000-0000-0000-0000-000000000001",
        aud: str = "authenticated",
        exp_offset: int = 3600,
        extra_claims: dict[str, Any] | None = None,
    ) -> str:
        now = int(time.time())
        claims: dict[str, Any] = {
            "sub": sub,
            "aud": aud,
            "iat": now,
            "exp": now + exp_offset,
        }
        if extra_claims:
            claims.update(extra_claims)
        return jwt.encode(
            claims,
            self.pem,
            algorithm="ES256",
            headers={"kid": self.kid},
        )


@pytest.fixture
def signing_key() -> SigningKey:
    return SigningKey(kid="test-key-1")


@pytest.fixture
def rotated_key() -> SigningKey:
    return SigningKey(kid="test-key-2")


@pytest.fixture
def patch_jwks(
    monkeypatch: pytest.MonkeyPatch,
) -> Iterator[Callable[[list[SigningKey]], list[int]]]:
    """Monkey-patches `_fetch_jwks` to return a JWKS built from the provided keys.

    Yields a setter that takes the current key list and returns a counter list
    (single-element, incremented on each fetch) so tests can assert refetch
    counts. Resets the module cache before and after each test.
    """
    fetch_count = [0]

    def install(keys: list[SigningKey]) -> list[int]:
        async def fake_fetch() -> dict[str, Any]:
            fetch_count[0] += 1
            return {"keys": [k.jwk for k in keys]}

        monkeypatch.setattr(auth_module, "_fetch_jwks", fake_fetch)
        return fetch_count

    auth_module._reset_jwks_cache_for_tests()
    yield install
    auth_module._reset_jwks_cache_for_tests()


@pytest.fixture
def client() -> TestClient:
    return TestClient(create_app())
