"""Tests for the JWT auth dependency."""

from __future__ import annotations

import time

from fastapi.testclient import TestClient
from jose import jwt

from tests.conftest import SigningKey


def test_valid_token_returns_user_id(
    client: TestClient,
    signing_key: SigningKey,
    patch_jwks,
) -> None:
    patch_jwks([signing_key])
    user_id = "11111111-1111-1111-1111-111111111111"
    token = signing_key.sign(sub=user_id)

    response = client.get("/api/me", headers={"Authorization": f"Bearer {token}"})

    assert response.status_code == 200
    assert response.json() == {"data": {"user_id": user_id}}


def test_missing_authorization_header_returns_401(client: TestClient) -> None:
    response = client.get("/api/me")
    assert response.status_code == 401
    body = response.json()
    assert body["code"] == "AUTH_MISSING_TOKEN"
    assert body["error"]


def test_malformed_token_returns_401(
    client: TestClient,
    signing_key: SigningKey,
    patch_jwks,
) -> None:
    patch_jwks([signing_key])
    response = client.get("/api/me", headers={"Authorization": "Bearer not-a-real-jwt"})
    assert response.status_code == 401
    assert response.json()["code"] == "AUTH_INVALID_TOKEN"


def test_expired_token_returns_401(
    client: TestClient,
    signing_key: SigningKey,
    patch_jwks,
) -> None:
    patch_jwks([signing_key])
    token = signing_key.sign(exp_offset=-60)  # expired 60s ago
    response = client.get("/api/me", headers={"Authorization": f"Bearer {token}"})
    assert response.status_code == 401
    assert response.json()["code"] == "AUTH_TOKEN_EXPIRED"


def test_forged_token_with_wrong_key_returns_401(
    client: TestClient,
    signing_key: SigningKey,
    rotated_key: SigningKey,
    patch_jwks,
) -> None:
    """A token signed with a key NOT in the JWKS must fail.

    The forged token reuses the published kid so the JWKS lookup hits, but the
    signature won't validate against the legitimate public half.
    """
    patch_jwks([signing_key])
    # Sign with the rotated_key's private material but claim signing_key's kid.
    now = int(time.time())
    forged = jwt.encode(
        {
            "sub": "attacker",
            "aud": "authenticated",
            "iat": now,
            "exp": now + 3600,
        },
        rotated_key.pem,
        algorithm="ES256",
        headers={"kid": signing_key.kid},
    )
    response = client.get("/api/me", headers={"Authorization": f"Bearer {forged}"})
    assert response.status_code == 401
    assert response.json()["code"] == "AUTH_INVALID_TOKEN"


def test_wrong_audience_returns_401(
    client: TestClient,
    signing_key: SigningKey,
    patch_jwks,
) -> None:
    patch_jwks([signing_key])
    token = signing_key.sign(aud="not-authenticated")
    response = client.get("/api/me", headers={"Authorization": f"Bearer {token}"})
    assert response.status_code == 401
    assert response.json()["code"] == "AUTH_INVALID_TOKEN"


def test_key_rotation_triggers_jwks_refetch(
    client: TestClient,
    signing_key: SigningKey,
    rotated_key: SigningKey,
    patch_jwks,
) -> None:
    """If a token uses a kid we don't have cached, JWKS is refetched once."""
    # Prime the cache with only the original key.
    fetch_count = patch_jwks([signing_key])
    initial_token = signing_key.sign()
    r1 = client.get("/api/me", headers={"Authorization": f"Bearer {initial_token}"})
    assert r1.status_code == 200
    assert fetch_count[0] == 1  # initial JWKS load

    # "Rotate": swap the fetcher to publish both keys. Cache still holds the
    # original snapshot — only the rotated kid being unknown will trigger a refetch.
    patch_jwks([signing_key, rotated_key])
    new_token = rotated_key.sign()
    r2 = client.get("/api/me", headers={"Authorization": f"Bearer {new_token}"})
    assert r2.status_code == 200
    # Total fetches: 1 (initial) + 1 (forced refresh after kid miss) = 2.
    assert fetch_count[0] == 2


def test_unknown_kid_after_refetch_returns_401(
    client: TestClient,
    signing_key: SigningKey,
    rotated_key: SigningKey,
    patch_jwks,
) -> None:
    """If even the refetch doesn't contain the kid, we 401 (don't loop forever)."""
    patch_jwks([signing_key])
    token = rotated_key.sign()  # signed with a key never in any JWKS
    response = client.get("/api/me", headers={"Authorization": f"Bearer {token}"})
    assert response.status_code == 401
    assert response.json()["code"] == "AUTH_UNKNOWN_KID"


def test_health_endpoint_does_not_require_auth(client: TestClient) -> None:
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json()["status"] == "healthy"


def test_empty_bearer_token_returns_401(client: TestClient) -> None:
    response = client.get("/api/me", headers={"Authorization": "Bearer "})
    assert response.status_code == 401
    # HTTPBearer with auto_error=False can surface this as either missing or invalid.
    assert response.json()["code"] in {"AUTH_MISSING_TOKEN", "AUTH_INVALID_TOKEN"}
