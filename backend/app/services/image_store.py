"""Supabase persistence for generated images and the subjects they depict.

`SupabaseImageStore` uses the backend secret key for the spend ledger RPCs and
the private `generated-images` Storage bucket. `SupabaseImageSubjects` reads
recipes and foods with the caller's JWT, so row level security decides which
household data the caller may request an image for.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any
from uuid import UUID

import httpx
from pydantic import ValidationError

from app.core.config import settings, validate_supabase_url
from app.models.recipes import RecipeSuggestion
from app.services.image_service import (
    ClaimLimits,
    FoodIdentity,
    ImageClaim,
    ImageKind,
    ImageStoreError,
)

_BUCKET = "generated-images"


class SupabaseImageStore:
    """Ledger RPCs and Storage calls made with the backend secret key."""

    def __init__(self, http_client: httpx.AsyncClient) -> None:
        self._http = http_client

    async def find_ready(self, kind: ImageKind, cache_key: str) -> str | None:
        """Return the stored path of a ready image, or None if there is none."""
        rows = await self._rest(
            "GET",
            "image_assets",
            params={
                "kind": f"eq.{kind}",
                "cache_key": f"eq.{cache_key}",
                "status": "eq.ready",
                "select": "object_path",
            },
        )
        return rows[0]["object_path"] if rows else None

    async def claim(
        self, kind: ImageKind, cache_key: str, requester: str, limits: ClaimLimits
    ) -> ImageClaim:
        """Call `claim_image_asset`. A `claimed` result has reserved spend."""
        rows = await self._rest(
            "POST",
            "rpc/claim_image_asset",
            json={
                "p_kind": kind,
                "p_cache_key": cache_key,
                "p_requester": requester,
                "p_cost_microusd": limits.cost_microusd,
                "p_monthly_cap_microusd": limits.cap_microusd,
                "p_requester_cap_microusd": limits.requester_cap_microusd,
                "p_max_attempts": limits.max_attempts,
                "p_retry_after_seconds": limits.retry_after_seconds,
                "p_lease_seconds": limits.lease_seconds,
            },
        )
        if len(rows) != 1:
            raise ImageStoreError("Image claim returned no row")
        try:
            return ImageClaim.model_validate(rows[0])
        except ValidationError as exc:
            raise ImageStoreError("Image claim returned invalid data") from exc

    async def settle(
        self, asset_id: UUID, reservation_id: UUID, object_path: str
    ) -> bool:
        """Mark the attempt ready. Return False if a newer attempt replaced it."""
        return await self._rpc_bool(
            "settle_image_asset",
            {
                "p_asset_id": str(asset_id),
                "p_reservation_id": str(reservation_id),
                "p_object_path": object_path,
            },
        )

    async def release(
        self, asset_id: UUID, reservation_id: UUID, *, refund: bool
    ) -> bool:
        """Mark the attempt failed, refunding its spend when `refund` is true."""
        return await self._rpc_bool(
            "release_image_asset",
            {
                "p_asset_id": str(asset_id),
                "p_reservation_id": str(reservation_id),
                "p_refund": refund,
            },
        )

    async def upload(self, object_path: str, data: bytes) -> None:
        """Write a WebP file to the bucket, replacing any file at that path."""
        await self._send(
            "POST",
            f"storage/v1/object/{_BUCKET}/{object_path}",
            content=data,
            headers={"Content-Type": "image/webp", "x-upsert": "true"},
        )

    async def signed_url(self, object_path: str, ttl_seconds: int) -> str:
        """Return an absolute URL that serves the file for `ttl_seconds`."""
        response = await self._send(
            "POST",
            f"storage/v1/object/sign/{_BUCKET}/{object_path}",
            json={"expiresIn": ttl_seconds},
        )
        body = _json(response)
        signed = body.get("signedURL") if isinstance(body, dict) else None
        if not isinstance(signed, str) or not signed.startswith("/"):
            raise ImageStoreError("Storage returned an invalid signed URL")
        return f"{settings.supabase_url}/storage/v1{signed}"

    async def _rpc_bool(self, name: str, payload: dict[str, Any]) -> bool:
        response = await self._send("POST", f"rest/v1/rpc/{name}", json=payload)
        result = _json(response)
        if not isinstance(result, bool):
            raise ImageStoreError(f"{name} returned invalid data")
        return result

    async def _rest(
        self,
        method: str,
        path: str,
        *,
        params: Mapping[str, str] | None = None,
        json: Any | None = None,
    ) -> list[dict[str, Any]]:
        response = await self._send(method, f"rest/v1/{path}", params=params, json=json)
        return _rows(response)

    async def _send(self, method: str, path: str, **kwargs: Any) -> httpx.Response:
        key, legacy_jwt = _backend_key()
        headers = {"apikey": key, **kwargs.pop("headers", {})}
        if legacy_jwt:
            headers["Authorization"] = f"Bearer {key}"
        return await _request(self._http, method, path, headers=headers, **kwargs)


class SupabaseImageSubjects:
    """Recipe and food reads made with the caller's JWT, so RLS applies."""

    def __init__(self, http_client: httpx.AsyncClient, user_token: str) -> None:
        self._http = http_client
        self._token = user_token

    async def find_feed_recipe(
        self, user_id: str, recipe_id: UUID
    ) -> RecipeSuggestion | None:
        """Return a recipe from the caller's feed, else None.

        Only the backend writes feed items, so these snapshots are safe to
        generate from.
        """
        return await self._recipe(
            "recipe_feed_items",
            {"user_id": f"eq.{user_id}", "recipe->>recipe_id": f"eq.{recipe_id}"},
        )

    async def find_saved_recipe(self, recipe_id: UUID) -> RecipeSuggestion | None:
        """Return a recipe saved by one of the caller's households, else None.

        Members write saved recipes directly, so their content is client text.
        """
        return await self._recipe("saved_recipes", {"recipe_id": f"eq.{recipe_id}"})

    async def find_food(self, food_id: UUID) -> FoodIdentity | None:
        """Return a food from one of the caller's households, else None."""
        rows = await self._get(
            "food_facts",
            {
                "id": f"eq.{food_id}",
                "select": "name,name_key,profile_key",
                "limit": "1",
            },
        )
        if not rows:
            return None
        try:
            return FoodIdentity.model_validate(rows[0])
        except ValidationError as exc:
            raise ImageStoreError("Stored food is invalid") from exc

    async def _recipe(
        self, table: str, filters: Mapping[str, str]
    ) -> RecipeSuggestion | None:
        rows = await self._get(table, {**filters, "select": "recipe", "limit": "1"})
        if not rows:
            return None
        try:
            return RecipeSuggestion.model_validate(rows[0]["recipe"])
        except (KeyError, TypeError, ValidationError) as exc:
            raise ImageStoreError("Stored recipe is invalid") from exc

    async def _get(self, table: str, params: Mapping[str, str]) -> list[dict]:
        key = settings.supabase_publishable_key or settings.supabase_anon_key
        if not key or not self._token:
            raise ImageStoreError("Supabase read credentials are missing")
        response = await _request(
            self._http,
            "GET",
            f"rest/v1/{table}",
            params=params,
            headers={"apikey": key, "Authorization": f"Bearer {self._token}"},
        )
        return _rows(response)


def _backend_key() -> tuple[str, bool]:
    """Return the backend key and whether it is a legacy JWT."""
    secret = settings.supabase_secret_key.get_secret_value()
    if secret:
        return secret, False
    legacy = settings.supabase_service_role_key.get_secret_value()
    if not legacy:
        raise ImageStoreError("Supabase backend key is not configured")
    return legacy, True


async def _request(
    client: httpx.AsyncClient,
    method: str,
    path: str,
    *,
    headers: dict[str, str],
    **kwargs: Any,
) -> httpx.Response:
    try:
        base = validate_supabase_url(settings.supabase_url)
    except ValueError as exc:
        raise ImageStoreError("Supabase URL must use a secure origin") from exc
    if not base:
        raise ImageStoreError("Supabase URL is not configured")
    try:
        response = await client.request(
            method,
            f"{base}/{path}",
            headers={"Accept": "application/json", **headers},
            timeout=settings.image_store_timeout_seconds,
            **kwargs,
        )
        response.raise_for_status()
    except httpx.HTTPStatusError as exc:
        raise ImageStoreError(
            f"Supabase returned HTTP {exc.response.status_code}"
        ) from exc
    except httpx.HTTPError as exc:
        raise ImageStoreError("Supabase request failed") from exc
    return response


def _json(response: httpx.Response) -> Any:
    try:
        return response.json()
    except ValueError as exc:
        raise ImageStoreError("Supabase returned invalid JSON") from exc


def _rows(response: httpx.Response) -> list[dict[str, Any]]:
    payload = _json(response) if response.content else []
    if not isinstance(payload, list) or not all(
        isinstance(row, Mapping) for row in payload
    ):
        raise ImageStoreError("Supabase returned invalid rows")
    return [dict(row) for row in payload]
