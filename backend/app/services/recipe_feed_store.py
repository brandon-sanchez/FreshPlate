"""User-scoped persistence for cursor-backed recipe feed sessions."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from datetime import datetime
from typing import Any, Protocol
from uuid import UUID

import httpx
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from app.core.config import settings, validate_supabase_url
from app.models.recipes import RecipeSuggestion

RECIPE_FEED_SESSIONS_TABLE = "recipe_feed_sessions"
RECIPE_FEED_ITEMS_TABLE = "recipe_feed_items"


class RecipeFeedStoreError(RuntimeError):
    """Raised when a feed session cannot be read or persisted."""


class RecipeFeedSession(BaseModel):
    """The server-owned state needed to refill one feed."""

    model_config = ConfigDict(extra="forbid")

    id: UUID
    user_id: str = Field(min_length=1)
    inventory: list[dict[str, Any]] = Field(default_factory=list)
    preferences: dict[str, Any] = Field(default_factory=dict)
    usable_items: list[dict[str, Any]] = Field(default_factory=list)
    retrieved_recipes: list[dict[str, Any]] = Field(default_factory=list)
    retrieval_cursor: int = Field(default=0, ge=0)
    exclude_titles: list[str] = Field(default_factory=list)
    candidate_count: int = Field(default=0, ge=0)
    generation_runs: int = Field(default=0, ge=0)
    has_more: bool = True
    refill_claim_id: UUID | None = None
    refill_claim_expires_at: datetime | None = None
    completed_refill_claim_id: UUID | None = None
    created_at: datetime | None = None
    expires_at: datetime | None = None


class RecipeFeedStore(Protocol):
    """Persistence seam used by the API and replaced by fakes in tests."""

    async def create_session(
        self, session: RecipeFeedSession, *, recipes: Sequence[RecipeSuggestion] = ()
    ) -> None: ...

    async def get_session(
        self,
        user_id: str,
        session_id: UUID,
    ) -> RecipeFeedSession | None: ...

    async def list_candidates(
        self,
        user_id: str,
        session_id: UUID,
        *,
        start_position: int,
        limit: int,
    ) -> list[RecipeSuggestion]: ...

    async def claim_refill(
        self,
        user_id: str,
        session_id: UUID,
        *,
        expected_generation_runs: int,
        claim_id: UUID,
    ) -> RecipeFeedSession: ...

    async def finalize_refill(
        self,
        user_id: str,
        session_id: UUID,
        *,
        claim_id: UUID,
        recipes: Sequence[RecipeSuggestion],
        exclude_titles: list[str],
        retrieval_cursor: int,
    ) -> RecipeFeedSession: ...
    async def release_refill(
        self,
        user_id: str,
        session_id: UUID,
        *,
        claim_id: UUID,
    ) -> None: ...


class SupabaseRecipeFeedStore:
    """Use caller JWTs for reads and backend credentials for atomic writes.

    Every mutation RPC receives the user id verified by FastAPI authentication.
    Client roles cannot execute these RPCs or mutate the underlying feed tables.
    """

    def __init__(
        self,
        user_token: str,
        url: str | None = None,
        anon_key: str | None = None,
        *,
        publishable_key: str | None = None,
        secret_key: str | None = None,
        service_role_key: str | None = None,
        http_client: Any | None = None,
    ) -> None:
        if publishable_key is not None and anon_key is not None:
            raise ValueError("Provide either publishable_key or anon_key, not both")
        self._url = settings.supabase_url if url is None else url
        if publishable_key is not None:
            self._api_key = publishable_key
        elif anon_key is not None:
            self._api_key = anon_key
        elif settings.supabase_publishable_key:
            self._api_key = settings.supabase_publishable_key
        else:
            self._api_key = settings.supabase_anon_key
        if secret_key is not None and service_role_key is not None:
            raise ValueError("Provide either secret_key or service_role_key, not both")
        if secret_key is not None:
            self._write_key = secret_key
            self._write_uses_legacy_jwt = False
        elif service_role_key is not None:
            self._write_key = service_role_key
            self._write_uses_legacy_jwt = True
        elif settings.supabase_secret_key.get_secret_value():
            self._write_key = settings.supabase_secret_key.get_secret_value()
            self._write_uses_legacy_jwt = False
        else:
            self._write_key = settings.supabase_service_role_key.get_secret_value()
            self._write_uses_legacy_jwt = True
        self._user_token = user_token.strip()
        self._http_client = http_client

    async def create_session(
        self, session: RecipeFeedSession, *, recipes: Sequence[RecipeSuggestion] = ()
    ) -> None:
        """Commit the initial session and its candidate pool in one transaction."""
        persisted = await self._session_rpc(
            "create_recipe_feed_session",
            {
                "p_user_id": session.user_id,
                "p_session": session.model_dump(mode="json", exclude_none=True),
                "p_recipes": [recipe.model_dump(mode="json") for recipe in recipes],
            },
        )
        if persisted.id != session.id or persisted.user_id != session.user_id:
            raise RecipeFeedStoreError("Recipe feed session identity changed")

    async def get_session(
        self,
        user_id: str,
        session_id: UUID,
    ) -> RecipeFeedSession | None:
        rows = await self._request(
            "GET",
            RECIPE_FEED_SESSIONS_TABLE,
            params={
                "id": f"eq.{session_id}",
                "user_id": f"eq.{user_id}",
                "limit": "1",
            },
        )
        if not rows:
            return None
        try:
            return RecipeFeedSession.model_validate(rows[0])
        except (TypeError, ValidationError) as exc:
            raise RecipeFeedStoreError(
                "Recipe feed session returned invalid data"
            ) from exc

    async def list_candidates(
        self,
        user_id: str,
        session_id: UUID,
        *,
        start_position: int,
        limit: int,
    ) -> list[RecipeSuggestion]:
        rows = await self._request(
            "GET",
            RECIPE_FEED_ITEMS_TABLE,
            params={
                "user_id": f"eq.{user_id}",
                "session_id": f"eq.{session_id}",
                "position": f"gte.{start_position}",
                "order": "position.asc",
                "limit": str(limit),
            },
        )
        recipes: list[RecipeSuggestion] = []
        try:
            for row in rows:
                recipe = row.get("recipe")
                recipes.append(RecipeSuggestion.model_validate(recipe))
        except (AttributeError, TypeError, ValidationError) as exc:
            raise RecipeFeedStoreError(
                "Recipe feed items returned invalid data"
            ) from exc
        return recipes

    async def claim_refill(
        self,
        user_id: str,
        session_id: UUID,
        *,
        expected_generation_runs: int,
        claim_id: UUID,
    ) -> RecipeFeedSession:
        """Reserve a bounded generation run or return the current session."""
        return await self._session_rpc(
            "claim_recipe_feed_refill",
            {
                "p_user_id": user_id,
                "p_session_id": str(session_id),
                "p_expected_generation_runs": expected_generation_runs,
                "p_claim_id": str(claim_id),
            },
        )

    async def finalize_refill(
        self,
        user_id: str,
        session_id: UUID,
        *,
        claim_id: UUID,
        recipes: Sequence[RecipeSuggestion],
        exclude_titles: list[str],
        retrieval_cursor: int,
    ) -> RecipeFeedSession:
        """Atomically append candidates and advance only the claimed session."""
        return await self._session_rpc(
            "finalize_recipe_feed_refill",
            {
                "p_user_id": user_id,
                "p_session_id": str(session_id),
                "p_claim_id": str(claim_id),
                "p_recipes": [recipe.model_dump(mode="json") for recipe in recipes],
                "p_exclude_titles": exclude_titles,
                "p_retrieval_cursor": retrieval_cursor,
            },
        )

    async def release_refill(
        self,
        user_id: str,
        session_id: UUID,
        *,
        claim_id: UUID,
    ) -> None:
        """Permit a retry after a known failure without refunding its run."""
        await self._request(
            "POST",
            "rpc/release_recipe_feed_refill",
            trusted=True,
            json={
                "p_user_id": user_id,
                "p_session_id": str(session_id),
                "p_claim_id": str(claim_id),
            },
        )

    async def _session_rpc(
        self,
        name: str,
        payload: dict[str, Any],
    ) -> RecipeFeedSession:
        rows = await self._request("POST", f"rpc/{name}", json=payload, trusted=True)
        if len(rows) != 1:
            raise RecipeFeedStoreError("Recipe feed session could not be persisted")
        try:
            return RecipeFeedSession.model_validate(rows[0])
        except (TypeError, ValidationError) as exc:
            raise RecipeFeedStoreError("Recipe feed RPC returned invalid data") from exc

    async def _request(
        self,
        method: str,
        table_path: str,
        *,
        params: Mapping[str, str] | None = None,
        json: Any | None = None,
        trusted: bool = False,
    ) -> list[dict[str, Any]]:
        if not self._url:
            raise RecipeFeedStoreError("Supabase URL is not configured")
        try:
            validate_supabase_url(self._url)
        except ValueError as exc:
            raise RecipeFeedStoreError("Supabase URL must use a secure origin") from exc
        if trusted:
            if not self._write_key:
                raise RecipeFeedStoreError("Supabase backend key is not configured")
            headers = {"apikey": self._write_key}
            if self._write_uses_legacy_jwt:
                headers["Authorization"] = f"Bearer {self._write_key}"
        else:
            if not self._api_key or not self._user_token:
                raise RecipeFeedStoreError("Recipe feed read credentials are missing")
            headers = {
                "apikey": self._api_key,
                "Authorization": f"Bearer {self._user_token}",
            }
        headers["Accept"] = "application/json"
        if json is not None:
            headers["Content-Type"] = "application/json"
        url = f"{self._url.rstrip('/')}/rest/v1/{table_path}"

        try:
            if self._http_client is None:
                async with httpx.AsyncClient(
                    timeout=settings.recipe_feed_store_timeout_seconds
                ) as client:
                    response = await client.request(
                        method,
                        url,
                        headers=headers,
                        params=params,
                        json=json,
                        timeout=settings.recipe_feed_store_timeout_seconds,
                    )
            else:
                response = await self._http_client.request(
                    method,
                    url,
                    headers=headers,
                    params=params,
                    json=json,
                    timeout=settings.recipe_feed_store_timeout_seconds,
                )
            response.raise_for_status()
        except httpx.TimeoutException as exc:
            raise RecipeFeedStoreError("Recipe feed store timed out") from exc
        except httpx.HTTPStatusError as exc:
            raise RecipeFeedStoreError(
                f"Recipe feed store returned HTTP {exc.response.status_code}"
            ) from exc
        except httpx.HTTPError as exc:
            raise RecipeFeedStoreError("Recipe feed store request failed") from exc

        if not getattr(response, "text", ""):
            return []
        try:
            payload = response.json()
        except (TypeError, ValueError) as exc:
            raise RecipeFeedStoreError(
                "Recipe feed store returned invalid JSON"
            ) from exc
        if not isinstance(payload, list) or any(
            not isinstance(row, Mapping) for row in payload
        ):
            raise RecipeFeedStoreError("Recipe feed store returned invalid rows")
        return [dict(row) for row in payload]
