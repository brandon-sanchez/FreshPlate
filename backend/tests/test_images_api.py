"""HTTP contract of the image endpoints."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Callable
from uuid import uuid4

import httpx
import pytest

from app.api.images import get_image_service, get_image_subjects
from app.services.image_service import FoodIdentity, ImageService, ImageStoreError
from tests.conftest import SigningKey
from tests.image_fakes import POLICY, FakeProvider, FakeStore, recipe

RECIPE_ID = uuid4()
FOOD_ID = uuid4()
TOMATO = FoodIdentity(name="Tomato", name_key="tomato", profile_key="tomato")


class FakeSubjects:
    def __init__(self, *, feed=None, saved=None, food=None, error=False) -> None:
        self.feed, self.saved, self.food, self.error = feed, saved, food, error

    async def find_feed_recipe(self, user_id, recipe_id):
        if self.error:
            raise ImageStoreError("down")
        return self.feed if recipe_id == RECIPE_ID else None

    async def find_saved_recipe(self, recipe_id):
        return self.saved if recipe_id == RECIPE_ID else None

    async def find_food(self, food_id):
        if self.error:
            raise ImageStoreError("down")
        return self.food if food_id == FOOD_ID else None


@dataclass
class Api:
    post: Callable[..., httpx.Response]
    store: FakeStore
    provider: FakeProvider


@pytest.fixture
def api(client, signing_key: SigningKey, patch_jwks) -> Api:
    patch_jwks([signing_key])
    store, provider = FakeStore(), FakeProvider()
    images = ImageService(store, provider, POLICY)
    client.app.dependency_overrides[get_image_service] = lambda: images

    def post(path: str, subjects: FakeSubjects, *, auth: bool = True):
        client.app.dependency_overrides[get_image_subjects] = lambda: subjects
        headers = {"Authorization": f"Bearer {signing_key.sign()}"} if auth else {}
        return client.post(path, headers=headers)

    return Api(post, store, provider)


def test_anonymous_request_is_rejected_before_any_lookup(api):
    response = api.post(
        f"/api/images/recipes/{RECIPE_ID}", FakeSubjects(feed=recipe()), auth=False
    )
    assert response.status_code == 401
    assert api.provider.prompts == []


def test_feed_recipe_photo_is_generated_and_returned_in_the_envelope(api):
    response = api.post(f"/api/images/recipes/{RECIPE_ID}", FakeSubjects(feed=recipe()))
    assert response.status_code == 200
    data = response.json()["data"]
    assert data["status"] == "ready" and data["url"].startswith("https://cdn.test/")
    assert data["reason"] is None and len(data["image_key"]) == 64
    assert len(api.store.requesters) == 1


def test_saved_recipe_reuses_the_feed_photo(api):
    dish = recipe()
    feed = api.post(f"/api/images/recipes/{RECIPE_ID}", FakeSubjects(feed=dish))
    saved = api.post(f"/api/images/recipes/{RECIPE_ID}", FakeSubjects(saved=dish))
    assert saved.json()["data"]["image_key"] == feed.json()["data"]["image_key"]
    assert saved.json()["data"]["status"] == "ready"
    assert len(api.provider.prompts) == 1


def test_saved_recipe_never_starts_a_paid_generation(api):
    response = api.post(
        f"/api/images/recipes/{RECIPE_ID}", FakeSubjects(saved=recipe())
    )
    data = response.json()["data"]
    assert (data["status"], data["reason"]) == ("unavailable", "disabled")
    assert api.provider.prompts == [] and api.store.requesters == []


def test_recipe_outside_the_callers_households_is_404_and_free(api):
    response = api.post(f"/api/images/recipes/{uuid4()}", FakeSubjects(feed=recipe()))
    assert response.status_code == 404
    assert response.json()["code"] == "IMAGE_SUBJECT_NOT_FOUND"
    assert api.provider.prompts == [] and api.store.spent == 0


def test_food_thumbnail_is_returned(api):
    response = api.post(f"/api/images/foods/{FOOD_ID}", FakeSubjects(food=TOMATO))
    assert response.json()["data"]["status"] == "ready"


def test_food_outside_the_callers_households_is_404(api):
    response = api.post(f"/api/images/foods/{uuid4()}", FakeSubjects(food=TOMATO))
    assert response.status_code == 404
    assert api.provider.prompts == []


def test_placeholder_results_are_200_with_a_reason(api):
    api.store.spent = POLICY.monthly_cap_microusd
    response = api.post(f"/api/images/recipes/{RECIPE_ID}", FakeSubjects(feed=recipe()))
    assert response.status_code == 200
    data = response.json()["data"]
    assert {key: data[key] for key in ("status", "url", "expires_at", "reason")} == {
        "status": "unavailable",
        "url": None,
        "expires_at": None,
        "reason": "budget_exhausted",
    }


@pytest.mark.parametrize("path", [f"recipes/{RECIPE_ID}", f"foods/{FOOD_ID}"])
def test_supabase_outage_is_503(api, path):
    response = api.post(f"/api/images/{path}", FakeSubjects(error=True))
    assert response.status_code == 503
    assert response.json()["code"] == "IMAGE_UNAVAILABLE"


def test_lookups_use_the_callers_token_for_any_bearer_casing(
    api, client, signing_key: SigningKey, monkeypatch
):
    client.app.dependency_overrides.pop(get_image_subjects, None)
    monkeypatch.setattr(
        "app.services.image_store.settings.supabase_url", "https://sb.test"
    )
    monkeypatch.setattr(
        "app.services.image_store.settings.supabase_publishable_key", "sb_publishable"
    )
    seen: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request.headers["authorization"])
        return httpx.Response(200, json=[])

    client.app.state.supabase_http_client = httpx.AsyncClient(
        transport=httpx.MockTransport(handler)
    )
    token = signing_key.sign()
    response = client.post(
        f"/api/images/foods/{FOOD_ID}", headers={"Authorization": f"bearer {token}"}
    )
    assert response.status_code == 404
    assert seen == [f"Bearer {token}"]
