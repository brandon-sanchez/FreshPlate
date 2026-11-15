"""Serve generated recipe and ingredient images under a global monthly budget.

Each image is generated at most once per cache key: a dish and its
ingredients, or an ingredient's identity. A request first claims the key in
the database ledger. The claim reserves spend under the cap before any
provider call. The attempt then ends by settling the claim with the stored
file or by releasing it. Requests never retry the provider themselves. A
failed image is attempted again only by a later request, after the ledger's
cooldown and within its attempt limit.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
from datetime import datetime, timedelta, timezone
from io import BytesIO
from typing import Literal, Protocol
from uuid import UUID

from PIL import Image
from pydantic import BaseModel

from app.ai.agents.models import Recipe
from app.ai.images.openai import MAX_PROMPT_BYTES
from app.ai.images.prompts import (
    ingredient_image_prompt,
    recipe_image_prompt,
    recipe_photo_subject,
)
from app.ai.llm.errors import ProviderError
from app.core.config import Settings

logger = logging.getLogger("freshplate.images")

_UPLOAD_GRACE_SECONDS = 60
_WEBP_QUALITY = 82

ImageKind = Literal["recipe", "ingredient"]
ClaimOutcome = Literal["ready", "claimed", "in_progress", "failed", "budget_exhausted"]
UnavailableReason = Literal["disabled", "budget_exhausted", "failed"]


class ImageStoreError(RuntimeError):
    """Raised when Supabase cannot be reached or returns an unexpected response."""


class ImageClaim(BaseModel):
    """The result of `claim_image_asset`.

    Attributes:
        outcome: What the caller may do next. Only `claimed` permits a provider
            call. That attempt must end in `settle` or `release`.
        asset_id: The image's ledger row. None only when the budget is exhausted
            for an image that was never claimed.
        reservation_id: The attempt to settle or release. Set only for `claimed`.
        object_path: The stored file. Set only for `ready`.
    """

    outcome: ClaimOutcome
    asset_id: UUID | None = None
    reservation_id: UUID | None = None
    object_path: str | None = None


class ClaimLimits(BaseModel):
    """Spend and retry bounds passed to every claim.

    Attributes:
        cost_microusd: Spend to reserve for this attempt.
        cap_microusd: Global cap for the current UTC month.
        requester_cap_microusd: Cap for the requesting user in that month.
        max_attempts: Possibly billed attempts allowed per image.
        retry_after_seconds: Wait after a failure before another attempt.
        lease_seconds: How long an attempt may run before it is presumed dead.
    """

    cost_microusd: int
    cap_microusd: int
    requester_cap_microusd: int
    max_attempts: int
    retry_after_seconds: int
    lease_seconds: int


class FoodIdentity(BaseModel):
    """The parts of a household food that decide which ingredient image it shows.

    Attributes:
        name: The household's display name. Used in the prompt only when the
            food has no profile.
        name_key: The normalized name (`food_name_key`).
        profile_key: The shared food profile, when the name resolves to one.
            Its key is reference data, so it names the shared image.
    """

    name: str
    name_key: str
    profile_key: str | None = None


class ImageStore(Protocol):
    """The spend ledger and image file storage behind `ImageService`."""

    async def find_ready(self, kind: ImageKind, cache_key: str) -> str | None: ...

    async def claim(
        self, kind: ImageKind, cache_key: str, requester: str, limits: ClaimLimits
    ) -> ImageClaim: ...

    async def settle(
        self, asset_id: UUID, reservation_id: UUID, object_path: str
    ) -> bool: ...

    async def release(
        self, asset_id: UUID, reservation_id: UUID, *, refund: bool
    ) -> bool: ...

    async def upload(self, object_path: str, data: bytes) -> None: ...

    async def signed_url(self, object_path: str, ttl_seconds: int) -> str: ...


class ImageSubjects(Protocol):
    """Caller-scoped reads of what an image may be requested for."""

    async def find_feed_recipe(
        self, user_id: str, recipe_id: UUID
    ) -> Recipe | None: ...

    async def find_saved_recipe(self, recipe_id: UUID) -> Recipe | None: ...

    async def find_food(self, food_id: UUID) -> FoodIdentity | None: ...


class ImageProvider(Protocol):
    """Generates one PNG, or returns None when generation is not configured."""

    async def generate(self, prompt: str, *, kind: str) -> bytes | None: ...


class ImagePolicy(BaseModel):
    """Generation switch, spend and retry bounds, built from `Settings`.

    Attributes:
        enabled: Whether misses may call the provider. When false, only
            already stored images are served.
        monthly_cap_microusd: Global cap per UTC month for both kinds.
        user_monthly_cap_microusd: Cap per requesting user per UTC month.
        recipe_cost_microusd: Spend reserved per recipe photo attempt.
        ingredient_cost_microusd: Spend reserved per ingredient thumbnail attempt.
        max_attempts: Possibly billed attempts allowed per image.
        retry_after_seconds: Wait after a failure before a later request may
            make the next attempt.
        timeout_seconds: Provider deadline per attempt.
        signed_url_ttl_seconds: Lifetime of returned image URLs.
    """

    enabled: bool
    monthly_cap_microusd: int
    user_monthly_cap_microusd: int
    recipe_cost_microusd: int
    ingredient_cost_microusd: int
    max_attempts: int
    retry_after_seconds: int
    timeout_seconds: float
    signed_url_ttl_seconds: int

    @classmethod
    def from_settings(cls, settings: Settings) -> ImagePolicy:
        """Read the policy from settings.

        Generation counts as enabled only when it is switched on, an OpenAI key
        is set, and both caps are positive.
        """
        return cls(
            enabled=(
                settings.image_generation_enabled
                and bool(settings.openai_api_key.get_secret_value())
                and settings.image_generation_monthly_cap_microusd > 0
                and settings.image_generation_user_monthly_cap_microusd > 0
            ),
            monthly_cap_microusd=settings.image_generation_monthly_cap_microusd,
            user_monthly_cap_microusd=settings.image_generation_user_monthly_cap_microusd,
            recipe_cost_microusd=settings.recipe_image_cost_microusd,
            ingredient_cost_microusd=settings.ingredient_image_cost_microusd,
            max_attempts=settings.image_generation_max_attempts,
            retry_after_seconds=settings.image_generation_retry_after_seconds,
            timeout_seconds=settings.image_generation_timeout_seconds,
            signed_url_ttl_seconds=settings.image_signed_url_ttl_seconds,
        )

    def limits(self, kind: ImageKind) -> ClaimLimits:
        """Return the claim bounds for one image of `kind`."""
        cost = (
            self.recipe_cost_microusd
            if kind == "recipe"
            else self.ingredient_cost_microusd
        )
        return ClaimLimits(
            cost_microusd=cost,
            cap_microusd=self.monthly_cap_microusd,
            requester_cap_microusd=self.user_monthly_cap_microusd,
            max_attempts=self.max_attempts,
            retry_after_seconds=self.retry_after_seconds,
            lease_seconds=int(self.timeout_seconds) + _UPLOAD_GRACE_SECONDS,
        )


class ImageResult(BaseModel):
    """What a screen shows for one image.

    Attributes:
        status: `ready` when `url` serves the image, `pending` while another
            request generates it, or `unavailable` when the screen shows its
            placeholder.
        image_key: Stable identity of the image, the same for every view of
            one dish or ingredient. Suitable as a client cache key,
            since `url` changes each time it is signed.
        url: Signed URL of the WebP image. Set only when ready.
        expires_at: When `url` stops working. Set only when ready.
        reason: Why the image is unavailable. `disabled`: generation is off
            or unconfigured, or the recipe can only be served from cache.
            `budget_exhausted`: the global or the caller's monthly cap is
            reached. `failed`: the last attempt failed. A later request may
            retry after the cooldown, up to the attempt limit, but a prompt
            over the provider limit always fails. Set only when unavailable.
    """

    status: Literal["ready", "pending", "unavailable"]
    image_key: str
    url: str | None = None
    expires_at: datetime | None = None
    reason: UnavailableReason | None = None

    @classmethod
    def pending(cls, image_key: str) -> ImageResult:
        """Return the result for an image another request is generating."""
        return cls(status="pending", image_key=image_key)

    @classmethod
    def unavailable(cls, image_key: str, reason: UnavailableReason) -> ImageResult:
        """Return the placeholder result for `reason`."""
        return cls(status="unavailable", image_key=image_key, reason=reason)


class ImageService:
    """Cached, budgeted image generation shared by every request in a process.

    One instance must serve the whole process: it collapses concurrent
    requests for the same image into one claim and one provider call.
    Across processes the database ledger does the same, and the losers get
    `pending`.
    """

    def __init__(
        self, store: ImageStore, provider: ImageProvider, policy: ImagePolicy
    ) -> None:
        self._store = store
        self._provider = provider
        self._policy = policy
        self._inflight: dict[
            tuple[ImageKind, str, bool], asyncio.Task[ImageResult]
        ] = {}

    @staticmethod
    def recipe_key(recipe: Recipe) -> str:
        """Return the cache key of a recipe's photo.

        The key is the dish title plus the set of ingredient names, as
        `recipe_photo_subject` normalizes them. Ingredient order, duplicates,
        amounts, units, steps, servings and cook time are left out, because
        the photo prompt leaves them out too. Adding, removing or swapping an
        ingredient, or renaming the dish, gives a new key. Names are used
        rather than food ids, which belong to one household, so households
        that get the same dish share its photo. The photo shows only food,
        so sharing it reveals nothing about a household.
        """
        title, ingredients = recipe_photo_subject(recipe)
        content = {"title": title, "ingredients": ingredients}
        return _digest("recipe", json.dumps(content, sort_keys=True))

    @staticmethod
    def food_key(food: FoodIdentity) -> str:
        """Return the cache key of an ingredient.

        Foods that resolve to one shared food profile share an image across
        households. Other foods share one by normalized name.
        """
        if food.profile_key:
            return _digest("ingredient", "profile:" + food.profile_key)
        return _digest("ingredient", "name:" + food.name_key)

    async def recipe_image(
        self, recipe: Recipe, requester: str, *, generate: bool
    ) -> ImageResult:
        """Return the photo for a recipe, generating it on the first request.

        Args:
            recipe: A validated recipe the caller is allowed to see.
            requester: The user charged for a generation.
            generate: Whether a miss may generate. Pass True only for
                snapshots the backend wrote, since a client-written recipe
                would let a user choose the prompt.

        Returns:
            The image, `pending`, or `unavailable` with a reason.

        Raises:
            ImageStoreError: The ledger or Storage could not be reached.
        """
        return await self._image(
            "recipe",
            self.recipe_key(recipe),
            recipe_image_prompt(recipe),
            requester,
            generate=generate,
        )

    async def food_image(self, food: FoodIdentity, requester: str) -> ImageResult:
        """Return the thumbnail for an ingredient, generating it on first request.

        Args:
            food: A food from one of the caller's households.
            requester: The user charged for a generation.

        Returns:
            The image, `pending`, or `unavailable` with a reason.

        Raises:
            ImageStoreError: The ledger or Storage could not be reached.
        """
        return await self._image(
            "ingredient",
            self.food_key(food),
            ingredient_image_prompt(food.profile_key or food.name),
            requester,
            generate=True,
        )

    async def _image(
        self,
        kind: ImageKind,
        key: str,
        prompt: str,
        requester: str,
        *,
        generate: bool,
    ) -> ImageResult:
        flight = (kind, key, generate and self._policy.enabled)
        task = self._inflight.get(flight)
        if task is None:
            # A separate task, so a caller that disconnects mid-generation
            # cannot cancel an attempt that is already billed.
            task = asyncio.create_task(
                self._resolve(kind, key, prompt, requester, generate=flight[2])
            )
            self._inflight[flight] = task
            task.add_done_callback(lambda _: self._inflight.pop(flight, None))
        return await asyncio.shield(task)

    async def _resolve(
        self,
        kind: ImageKind,
        key: str,
        prompt: str,
        requester: str,
        *,
        generate: bool,
    ) -> ImageResult:
        if not generate:
            path = await self._store.find_ready(kind, key)
            if path is None:
                return ImageResult.unavailable(key, "disabled")
            return await self._ready(key, path)
        if len(prompt.encode()) > MAX_PROMPT_BYTES:
            return ImageResult.unavailable(key, "failed")
        claim = await self._store.claim(kind, key, requester, self._policy.limits(kind))
        if claim.outcome == "ready" and claim.object_path:
            return await self._ready(key, claim.object_path)
        if claim.outcome == "in_progress":
            return ImageResult.pending(key)
        if claim.outcome == "claimed":
            return await self._generate(kind, key, prompt, claim)
        if claim.outcome == "budget_exhausted":
            return ImageResult.unavailable(key, "budget_exhausted")
        return ImageResult.unavailable(key, "failed")

    async def _generate(
        self, kind: ImageKind, key: str, prompt: str, claim: ImageClaim
    ) -> ImageResult:
        try:
            image = await asyncio.wait_for(
                self._provider.generate(prompt, kind=kind),
                timeout=self._policy.timeout_seconds,
            )
            webp = None if image is None else await asyncio.to_thread(_to_webp, image)
        except (ProviderError, TimeoutError, OSError, ValueError) as exc:
            # The provider does not bill an HTTP error response, because no
            # image was produced. Any other failure may have been billed.
            refund = isinstance(exc, ProviderError) and exc.status_code is not None
            await self._release_best_effort(claim, refund=refund)
            logger.warning(
                "image generation failed kind=%s error=%s refund=%s",
                kind,
                type(exc).__name__,
                refund,
            )
            return ImageResult.unavailable(key, "failed")
        if webp is None:
            await self._release_best_effort(claim, refund=True)
            return ImageResult.unavailable(key, "disabled")

        path = f"{kind}/{key}.webp"
        try:
            await self._store.upload(path, webp)
            settled = await self._store.settle(
                claim.asset_id, claim.reservation_id, path
            )
        except ImageStoreError:
            await self._release_best_effort(claim, refund=False)
            logger.warning("image storage failed kind=%s", kind)
            return ImageResult.unavailable(key, "failed")
        if not settled:
            return ImageResult.pending(key)
        return await self._ready(key, path)

    async def _ready(self, key: str, path: str) -> ImageResult:
        ttl = self._policy.signed_url_ttl_seconds
        url = await self._store.signed_url(path, ttl)
        expires_at = datetime.now(timezone.utc) + timedelta(seconds=ttl)
        return ImageResult(
            status="ready", image_key=key, url=url, expires_at=expires_at
        )

    async def _release_best_effort(self, claim: ImageClaim, *, refund: bool) -> None:
        try:
            await self._store.release(
                claim.asset_id, claim.reservation_id, refund=refund
            )
        except ImageStoreError:
            logger.warning("image release failed asset=%s", claim.asset_id)


def _digest(kind: str, identity: str) -> str:
    return hashlib.sha256(f"{kind}\n{identity}".encode()).hexdigest()


def _to_webp(png: bytes) -> bytes:
    with Image.open(BytesIO(png)) as decoded:
        out = BytesIO()
        decoded.convert("RGB").save(out, format="WEBP", quality=_WEBP_QUALITY)
    return out.getvalue()
