"""Backend-only PostgREST access to food facts and shared food profiles.

Every request uses the Supabase secret key or the legacy service-role JWT,
because no signed-in user may read every household's foods or write shared
profiles. Never expose this store's key to a client.
"""

from __future__ import annotations

from collections.abc import Mapping
from decimal import Decimal
from typing import Any
from uuid import UUID

import httpx

from app.core.config import settings, validate_supabase_url
from app.inventory.fact_estimates import ProfileEstimate

_TIMEOUT_SECONDS = 10.0
# Supabase caps a PostgREST response at 1,000 rows by default. Paging stops
# only on an empty page, so a lower project cap cannot end a read early.
_PAGE_SIZE = 1000


class FoodProfileStoreError(RuntimeError):
    """Raised when food facts cannot be read or an estimate cannot be saved."""


class SupabaseFoodProfileStore:
    """Read food facts across households and save profile estimates."""

    def __init__(
        self,
        url: str | None = None,
        *,
        secret_key: str | None = None,
        service_role_key: str | None = None,
        http_client: httpx.AsyncClient | None = None,
    ) -> None:
        """Configure the store, defaulting to the backend settings.

        Args:
            url: Supabase project URL. Defaults to ``SUPABASE_URL``.
            secret_key: Supabase secret key, sent as ``apikey``.
            service_role_key: Legacy service-role JWT, sent as ``apikey`` and
                bearer token. Used when no secret key is given or configured.
            http_client: Client to send requests with, for tests. Defaults to
                a new client per request.

        Raises:
            ValueError: When both keys are given.
        """
        if secret_key is not None and service_role_key is not None:
            raise ValueError("Provide either secret_key or service_role_key, not both")
        self._url = settings.supabase_url if url is None else url
        if secret_key is not None:
            self._key, self._legacy_jwt = secret_key, False
        elif service_role_key is not None:
            self._key, self._legacy_jwt = service_role_key, True
        elif settings.supabase_secret_key.get_secret_value():
            self._key = settings.supabase_secret_key.get_secret_value()
            self._legacy_jwt = False
        else:
            self._key = settings.supabase_service_role_key.get_secret_value()
            self._legacy_jwt = True
        self._http_client = http_client

    async def list_unestimated_food_facts(self) -> list[dict[str, Any]]:
        """Return live ``food_facts`` rows whose profile was never estimated.

        Covers every household, in food id order. Archived foods are left
        out. Rows with no profile are included, since their facts were never
        estimated either.

        Raises:
            FoodProfileStoreError: When Supabase cannot be reached or rejects
                the read.
        """
        rows: list[dict[str, Any]] = []
        while True:
            page = await self._request(
                "GET",
                "food_facts",
                params={
                    "archived_at": "is.null",
                    "profile_estimated_at": "is.null",
                    "order": "id",
                    "limit": str(_PAGE_SIZE),
                    "offset": str(len(rows)),
                },
            )
            if not isinstance(page, list) or not all(
                isinstance(row, Mapping) for row in page
            ):
                raise FoodProfileStoreError("food_facts returned invalid rows")
            if not page:
                return rows
            rows.extend(dict(row) for row in page)

    async def save_estimate(
        self, food_id: UUID | str, estimate: ProfileEstimate
    ) -> str | None:
        """Store an estimate on its profile and link the food to that profile.

        Calls ``save_food_profile_estimate``, which writes the facts only when
        the profile was never estimated and pins an unmatched food to the
        profile. Calling it again for the same profile changes no facts.

        Args:
            food_id: The ``foods.id`` the estimate was made for.
            estimate: The cleaned estimate.

        Returns:
            The profile key the food resolves to, or ``None`` when the food
            was renamed meanwhile to a name with no profile.

        Raises:
            FoodProfileStoreError: When the food does not exist, a fact is
                rejected, or Supabase cannot be reached.
        """
        resolved = await self._request(
            "POST",
            "rpc/save_food_profile_estimate",
            json={
                "p_food_id": str(food_id),
                "p_profile_name": estimate.profile_name,
                "p_g_per_ml": _number(estimate.g_per_ml),
                "p_unit_grams": {
                    unit: _number(grams) for unit, grams in estimate.unit_grams.items()
                },
                "p_estimated_by": estimate.estimated_by,
            },
        )
        if resolved is not None and not isinstance(resolved, str):
            raise FoodProfileStoreError(
                "save_food_profile_estimate returned invalid data"
            )
        return resolved

    async def _request(
        self,
        method: str,
        path: str,
        *,
        params: Mapping[str, str] | None = None,
        json: Any | None = None,
    ) -> Any:
        if not self._url:
            raise FoodProfileStoreError("Supabase URL is not configured")
        try:
            validate_supabase_url(self._url)
        except ValueError as exc:
            raise FoodProfileStoreError(
                "Supabase URL must use a secure origin"
            ) from exc
        if not self._key:
            raise FoodProfileStoreError("Supabase backend key is not configured")
        headers = {"apikey": self._key, "Accept": "application/json"}
        if self._legacy_jwt:
            headers["Authorization"] = f"Bearer {self._key}"
        url = f"{self._url.rstrip('/')}/rest/v1/{path}"

        try:
            if self._http_client is None:
                async with httpx.AsyncClient(timeout=_TIMEOUT_SECONDS) as client:
                    response = await client.request(
                        method, url, headers=headers, params=params, json=json
                    )
            else:
                response = await self._http_client.request(
                    method,
                    url,
                    headers=headers,
                    params=params,
                    json=json,
                    timeout=_TIMEOUT_SECONDS,
                )
            response.raise_for_status()
        except httpx.TimeoutException as exc:
            raise FoodProfileStoreError("Food profile store timed out") from exc
        except httpx.HTTPStatusError as exc:
            raise FoodProfileStoreError(
                f"Food profile store returned HTTP {exc.response.status_code}"
            ) from exc
        except httpx.HTTPError as exc:
            raise FoodProfileStoreError("Food profile store request failed") from exc

        try:
            return response.json()
        except ValueError as exc:
            raise FoodProfileStoreError(
                "Food profile store returned invalid JSON"
            ) from exc


def _number(value: Decimal | None) -> float | None:
    return None if value is None else float(value)
