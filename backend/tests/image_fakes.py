"""In-memory image provider, ledger and recipe fixtures for image tests."""

from __future__ import annotations

import asyncio
from io import BytesIO
from uuid import UUID, uuid4

from PIL import Image

from app.models.recipes import RecipeSuggestion
from app.services.image_service import (
    ClaimLimits,
    ImageClaim,
    ImagePolicy,
    ImageStoreError,
)


def png() -> bytes:
    out = BytesIO()
    Image.new("RGB", (8, 8), (200, 40, 40)).save(out, format="PNG")
    return out.getvalue()


class FakeProvider:
    def __init__(self, *results: object, delay: float = 0) -> None:
        self.results = list(results) or [png()]
        self.prompts: list[tuple[str, str]] = []
        self.delay = delay

    async def generate(self, prompt: str, *, kind: str) -> bytes | None:
        self.prompts.append((kind, prompt))
        await asyncio.sleep(self.delay)
        result = self.results[min(len(self.prompts), len(self.results)) - 1]
        if isinstance(result, BaseException):
            raise result
        return result


class FakeStore:
    """An in-memory ledger with the claim rules of `claim_image_asset`."""

    def __init__(self, spent: int = 0) -> None:
        self.spent = spent
        self.assets: dict[tuple[str, str], dict] = {}
        self.files: dict[str, bytes] = {}
        self.cooled_down = False
        self.requesters: list[str] = []
        self.fail_upload = False
        self.upload_delay = 0.0
        self.signing_delay = 0.0
        self.leases: list[int] = []

    def expire_leases(self) -> None:
        for asset in self.assets.values():
            asset["lease_expired"] = True

    async def find_ready(self, kind, cache_key):
        asset = self.assets.get((kind, cache_key))
        return asset["path"] if asset and asset["status"] == "ready" else None

    async def claim(self, kind, cache_key, requester, limits: ClaimLimits):
        self.requesters.append(requester)
        asset = self.assets.get((kind, cache_key))
        if asset:
            if asset["status"] == "ready":
                return ImageClaim(
                    outcome="ready", asset_id=asset["id"], object_path=asset["path"]
                )
            if asset["status"] == "reserved":
                if not asset.get("lease_expired"):
                    return ImageClaim(outcome="in_progress", asset_id=asset["id"])
            elif not self.cooled_down:
                return ImageClaim(outcome="failed", asset_id=asset["id"])
            if asset["attempts"] >= limits.max_attempts:
                return ImageClaim(outcome="failed", asset_id=asset["id"])
        if self.spent + limits.cost_microusd > limits.cap_microusd:
            return ImageClaim(
                outcome="budget_exhausted", asset_id=asset and asset["id"]
            )
        self.leases.append(limits.lease_seconds)
        self.spent += limits.cost_microusd
        asset = asset or {"id": uuid4(), "attempts": 0}
        asset.update(
            status="reserved",
            reservation=uuid4(),
            cost=limits.cost_microusd,
            attempts=asset["attempts"] + 1,
            lease_expired=False,
        )
        self.assets[(kind, cache_key)] = asset
        return ImageClaim(
            outcome="claimed", asset_id=asset["id"], reservation_id=asset["reservation"]
        )

    def _current(self, asset_id: UUID, reservation_id: UUID) -> dict | None:
        for asset in self.assets.values():
            if (
                asset["id"] == asset_id
                and asset["reservation"] == reservation_id
                and asset["status"] == "reserved"
            ):
                return asset
        return None

    async def settle(self, asset_id, reservation_id, object_path):
        asset = self._current(asset_id, reservation_id)
        if asset:
            asset.update(status="ready", path=object_path)
        return asset is not None

    async def release(self, asset_id, reservation_id, *, refund):
        asset = self._current(asset_id, reservation_id)
        if asset:
            asset["status"] = "failed"
            if refund:
                self.spent -= asset["cost"]
                asset["attempts"] -= 1
        return asset is not None

    async def upload(self, object_path, data):
        if self.fail_upload:
            raise ImageStoreError("Storage down")
        await asyncio.sleep(self.upload_delay)
        self.files[object_path] = data

    async def signed_url(self, object_path, ttl_seconds):
        await asyncio.sleep(self.signing_delay)
        return f"https://cdn.test/{object_path}?ttl={ttl_seconds}"


POLICY = ImagePolicy(
    enabled=True,
    monthly_cap_microusd=100,
    user_monthly_cap_microusd=100,
    recipe_cost_microusd=60,
    ingredient_cost_microusd=10,
    max_attempts=2,
    retry_after_seconds=900,
    timeout_seconds=5,
    signed_url_ttl_seconds=3600,
)


def recipe(title: str = "Tomato pasta", **changes) -> RecipeSuggestion:
    data = {
        "recipe_id": str(uuid4()),
        "title": title,
        "cook_time_minutes": 20,
        "servings": 2,
        "ingredients": [
            {"name": "spaghetti", "use_amount": 200, "unit": "g"},
            {"name": "tomato", "use_amount": 3, "unit": "each"},
        ],
        "steps": ["Boil the pasta.", "Toss with chopped tomato."],
        "match_percent": 90,
        **changes,
    }
    return RecipeSuggestion.model_validate(data)
