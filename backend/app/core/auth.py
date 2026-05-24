"""Supabase JWT verification.

Mobile sends `Authorization: Bearer <token>`. We verify the signature against the
project's JWKS (asymmetric ES256/RS256 keys), check `aud == "authenticated"` and
expiry, then expose the `sub` claim as `request.state.user_id` and as the
dependency's return value.

The JWKS is cached with a TTL. On a `kid` miss we refetch once before failing
so a key rotation can't cause a 1-hour outage.
"""

from __future__ import annotations

import asyncio
from typing import Annotated, Any

import httpx
from cachetools import TTLCache
from fastapi import Depends, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from jose import jwt
from jose.exceptions import ExpiredSignatureError, JWTError

from app.core.config import settings

_JWKS_CACHE_KEY = "jwks"
_jwks_cache: TTLCache[str, dict[str, Any]] = TTLCache(
    maxsize=1, ttl=settings.jwks_cache_ttl_seconds
)
_jwks_lock = asyncio.Lock()

# `auto_error=False` lets us return our own 401 payload shape instead of
# FastAPI's default `{"detail": "..."}`.
_bearer_scheme = HTTPBearer(auto_error=False)


def _unauthorized(message: str, code: str) -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail={"error": message, "code": code},
        headers={"WWW-Authenticate": "Bearer"},
    )


async def _fetch_jwks() -> dict[str, Any]:
    """Fetch the JWKS document from Supabase. Network errors propagate."""
    url = settings.supabase_jwks_url
    if not url:
        raise RuntimeError("supabase_url is not configured; cannot fetch JWKS")
    async with httpx.AsyncClient(timeout=settings.jwks_fetch_timeout_seconds) as client:
        response = await client.get(url)
        response.raise_for_status()
        return response.json()


async def get_jwks(*, force_refresh: bool = False) -> dict[str, Any]:
    """Return the JWKS, using cache when valid.

    `force_refresh=True` bypasses the cache (used when a `kid` lookup misses,
    suggesting a key rotation). The asyncio lock collapses concurrent misses
    so we don't stampede the JWKS endpoint.
    """
    if not force_refresh:
        cached = _jwks_cache.get(_JWKS_CACHE_KEY)
        if cached is not None:
            return cached

    async with _jwks_lock:
        if not force_refresh:
            cached = _jwks_cache.get(_JWKS_CACHE_KEY)
            if cached is not None:
                return cached
        jwks = await _fetch_jwks()
        _jwks_cache[_JWKS_CACHE_KEY] = jwks
        return jwks


def _find_key(jwks: dict[str, Any], kid: str | None) -> dict[str, Any] | None:
    keys = jwks.get("keys", [])
    if kid is None:
        # Tokens without `kid` are ambiguous when multiple keys are present.
        return keys[0] if len(keys) == 1 else None
    for key in keys:
        if key.get("kid") == kid:
            return key
    return None


async def _resolve_signing_key(token: str) -> dict[str, Any]:
    """Find the JWK that signed `token`. Refetches JWKS once on a kid miss."""
    try:
        header = jwt.get_unverified_header(token)
    except JWTError as exc:
        raise _unauthorized("Invalid token", "AUTH_INVALID_TOKEN") from exc

    kid = header.get("kid")
    jwks = await get_jwks()
    key = _find_key(jwks, kid)
    if key is None:
        # Possible key rotation — refetch once.
        jwks = await get_jwks(force_refresh=True)
        key = _find_key(jwks, kid)
    if key is None:
        raise _unauthorized("Unknown signing key", "AUTH_UNKNOWN_KID")
    return key


def _reset_jwks_cache_for_tests() -> None:
    """Test helper — clears the module-level JWKS cache between cases."""
    _jwks_cache.clear()


async def get_current_user(
    request: Request,
    credentials: Annotated[
        HTTPAuthorizationCredentials | None, Depends(_bearer_scheme)
    ],
) -> str:
    """FastAPI dependency: verifies the Bearer JWT and returns `user_id`.

    Side effect: sets `request.state.user_id` so downstream code without an
    explicit dependency can still read it.
    """
    if credentials is None or not credentials.credentials:
        raise _unauthorized("Missing or invalid Authorization header", "AUTH_MISSING_TOKEN")

    token = credentials.credentials
    key = await _resolve_signing_key(token)

    try:
        claims = jwt.decode(
            token,
            key,
            algorithms=[key.get("alg", "ES256")],
            audience=settings.supabase_jwt_audience,
        )
    except ExpiredSignatureError as exc:
        raise _unauthorized("Token has expired", "AUTH_TOKEN_EXPIRED") from exc
    except JWTError as exc:
        raise _unauthorized("Invalid token", "AUTH_INVALID_TOKEN") from exc

    user_id = claims.get("sub")
    if not user_id:
        raise _unauthorized("Token missing subject", "AUTH_INVALID_CLAIMS")

    request.state.user_id = user_id
    return user_id


CurrentUserId = Annotated[str, Depends(get_current_user)]
