"""User-scoped persistence for cursor-backed recipe feed sessions."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from datetime import datetime
from typing import Any, Protocol
from uuid import UUID

import httpx
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from app.core.config import settings
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
    created_at: datetime | None = None
    expires_at: datetime | None = None


class RecipeFeedStore(Protocol):
    """Persistence seam used by the API and replaced by fakes in tests."""

    async def create_session(self, session: RecipeFeedSession) -> None: ...

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

    async def append_candidates(
        self,
        user_id: str,
        session_id: UUID,
        *,
        start_position: int,
        recipes: Sequence[RecipeSuggestion],
    ) -> None: ...

    async def update_session(
        self,
        user_id: str,
        session_id: UUID,
        *,
        exclude_titles: list[str],
        candidate_count: int,
        generation_runs: int,
        retrieval_cursor: int,
        has_more: bool,
    ) -> None: ...


class SupabaseRecipeFeedStore:
    """Persist feed state through PostgREST with the caller's JWT.

    The publishable or legacy anon key identifies the project. The user's
    bearer token is forwarded separately so Supabase RLS scopes every request
    to the authenticated user instead of relying on a runtime service key.
    """

    def __init__(
        self,
        user_token: str,
        url: str | None = None,
        anon_key: str | None = None,
        *,
        publishable_key: str | None = None,
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
        self._user_token = user_token.strip()
        self._http_client = http_client

    async def create_session(self, session: RecipeFeedSession) -> None:
        rows = await self._request(
            "POST",
            RECIPE_FEED_SESSIONS_TABLE,
            json=[session.model_dump(mode="json", exclude_none=True)],
            prefer="return=representation",
        )
        if not rows:
            raise RecipeFeedStoreError("Recipe feed session was not persisted")
        try:
            persisted = RecipeFeedSession.model_validate(rows[0])
        except (TypeError, ValidationError) as exc:
            raise RecipeFeedStoreError(
                "Recipe feed session returned invalid data"
            ) from exc
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

    async def append_candidates(
        self,
        user_id: str,
        session_id: UUID,
        *,
        start_position: int,
        recipes: Sequence[RecipeSuggestion],
    ) -> None:
        if not recipes:
            return
        if start_position < 0:
            raise ValueError("Recipe feed candidate position must not be negative")
        rows = [
            {
                "id": str(recipe.recipe_id),
                "user_id": user_id,
                "session_id": str(session_id),
                "position": start_position + index,
                "recipe": recipe.model_dump(mode="json"),
            }
            for index, recipe in enumerate(recipes)
        ]
        await self._request(
            "POST",
            f"{RECIPE_FEED_ITEMS_TABLE}?on_conflict=session_id,position",
            json=rows,
            prefer="resolution=merge-duplicates,return=minimal",
        )

    async def update_session(
        self,
        user_id: str,
        session_id: UUID,
        *,
        exclude_titles: list[str],
        candidate_count: int,
        generation_runs: int,
        retrieval_cursor: int,
        has_more: bool,
    ) -> None:
        rows = await self._request(
            "PATCH",
            RECIPE_FEED_SESSIONS_TABLE,
            params={
                "id": f"eq.{session_id}",
                "user_id": f"eq.{user_id}",
            },
            json={
                "exclude_titles": exclude_titles,
                "candidate_count": candidate_count,
                "generation_runs": generation_runs,
                "retrieval_cursor": retrieval_cursor,
                "has_more": has_more,
            },
            prefer="return=representation",
        )
        if not rows:
            raise RecipeFeedStoreError("Recipe feed session could not be updated")

    async def _request(
        self,
        method: str,
        table_path: str,
        *,
        params: Mapping[str, str] | None = None,
        json: Any | None = None,
        prefer: str | None = None,
    ) -> list[dict[str, Any]]:
        if not self._url:
            raise RecipeFeedStoreError("Supabase URL is not configured")
        if not self._api_key:
            raise RecipeFeedStoreError(
                "Supabase publishable key or legacy anon key is not configured"
            )
        if not self._user_token:
            raise RecipeFeedStoreError("Recipe feed user token is not configured")

        headers = {
            "apikey": self._api_key,
            "Authorization": f"Bearer {self._user_token}",
            "Accept": "application/json",
        }
        if json is not None:
            headers["Content-Type"] = "application/json"
        if prefer is not None:
            headers["Prefer"] = prefer
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
                    )
            else:
                response = await self._http_client.request(
                    method,
                    url,
                    headers=headers,
                    params=params,
                    json=json,
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
