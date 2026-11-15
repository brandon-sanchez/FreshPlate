"""Behavior of the cached, budgeted image service with a fake provider."""

from __future__ import annotations

import asyncio
from io import BytesIO

import pytest
from PIL import Image

from app.ai.llm.errors import ProviderError
from app.core.config import Settings
from app.services.image_service import FoodIdentity, ImagePolicy, ImageService
from tests.image_fakes import POLICY, FakeProvider, FakeStore, png, recipe

USER = "00000000-0000-0000-0000-000000000001"
OTHER = "00000000-0000-0000-0000-000000000002"

pytestmark = pytest.mark.asyncio


def service(store=None, provider=None, **policy) -> ImageService:
    return ImageService(
        store or FakeStore(),
        provider or FakeProvider(),
        POLICY.model_copy(update=policy),
    )


async def test_first_request_generates_stores_webp_and_returns_a_signed_url():
    store, provider = FakeStore(), FakeProvider()
    result = await service(store, provider).recipe_image(recipe(), USER, generate=True)
    assert result.status == "ready"
    assert result.url and result.url.startswith("https://cdn.test/recipe/")
    assert result.url.endswith(".webp?ttl=3600")
    [data] = store.files.values()
    assert Image.open(BytesIO(data)).format == "WEBP"
    assert store.spent == 60
    assert [kind for kind, _ in provider.prompts] == ["recipe"]


async def test_recipe_prompt_lists_only_the_recipe_content():
    provider = FakeProvider()
    await service(provider=provider).recipe_image(recipe(), USER, generate=True)
    [(_, prompt)] = provider.prompts
    assert "Tomato pasta" in prompt
    assert "200 g spaghetti" in prompt and "3 each tomato" in prompt
    assert "1. Boil the pasta." in prompt
    assert "Do not add sides, garnishes" in prompt


async def test_same_recipe_snapshot_reuses_the_image_without_charging():
    store, provider = FakeStore(), FakeProvider()
    images = service(store, provider)
    feed_copy = recipe()
    saved_copy = feed_copy.model_copy(update={"match_percent": 40})
    first = await images.recipe_image(feed_copy, USER, generate=True)
    second = await images.recipe_image(saved_copy, USER, generate=True)
    assert second.status == "ready" and second.image_key == first.image_key
    assert len(provider.prompts) == 1 and store.spent == 60


def _ingredients(*names: str, amount: float = 1) -> list[dict]:
    return [{"name": name, "use_amount": amount, "unit": "each"} for name in names]


_BASE = {"title": "Tomato pasta", "ingredients": _ingredients("spaghetti", "tomato")}


@pytest.mark.parametrize(
    "variant",
    [
        {"title": "  tomato PASTA! "},
        {"title": "Tomato-pasta"},
        {"ingredients": _ingredients("Tomato", "Spaghetti")},
        {"ingredients": _ingredients("spaghetti", "tomato", amount=7)},
        {"ingredients": _ingredients("spaghetti", "tomato", "tomato")},
        {"steps": ["Bake it instead.", "Serve."]},
        {"servings": 6, "cook_time_minutes": 45},
    ],
)
async def test_recipe_key_ignores_order_amounts_steps_and_title_formatting(variant):
    assert ImageService.recipe_key(
        recipe(**{**_BASE, **variant})
    ) == ImageService.recipe_key(recipe(**_BASE))


@pytest.mark.parametrize(
    "variant",
    [
        {"ingredients": _ingredients("spaghetti", "tomato", "basil")},
        {"ingredients": _ingredients("spaghetti", "zucchini")},
        {"ingredients": _ingredients("spaghetti")},
        {"title": "Tomato soup"},
    ],
)
async def test_recipe_key_changes_with_the_ingredient_set_or_the_title(variant):
    assert ImageService.recipe_key(
        recipe(**{**_BASE, **variant})
    ) != ImageService.recipe_key(recipe(**_BASE))


async def test_recipes_from_different_households_share_a_photo():
    store, provider = FakeStore(), FakeProvider()
    images = service(store, provider)
    line = {"name": "tomato", "use_amount": 2, "unit": "each"}
    mine = recipe(ingredients=[{**line, "inventory_item_id": "food-a"}])
    theirs = recipe(
        ingredients=[{**line, "name": "Tomato", "inventory_item_id": "food-b"}]
    )
    first = await images.recipe_image(mine, USER, generate=True)
    second = await images.recipe_image(theirs, OTHER, generate=True)
    assert second.status == "ready" and second.image_key == first.image_key
    assert len(provider.prompts) == 1


async def test_ingredient_images_are_shared_by_profile_across_households():
    store, provider = FakeStore(), FakeProvider()
    images = service(store, provider)
    first = await images.food_image(
        FoodIdentity(
            name="Roma tomatoes", name_key="roma tomatoes", profile_key="tomato"
        ),
        USER,
    )
    second = await images.food_image(
        FoodIdentity(name="Tomato", name_key="tomato", profile_key="tomato"),
        OTHER,
    )
    assert second.image_key == first.image_key
    assert len(provider.prompts) == 1 and store.spent == 10
    assert provider.prompts[0][0] == "ingredient"
    assert "photograph of tomato," in provider.prompts[0][1]
    assert "Roma" not in provider.prompts[0][1]


async def test_unprofiled_foods_share_an_image_by_normalized_name():
    images = service()
    first = await images.food_image(
        FoodIdentity(name="Za'atar", name_key="za'atar"), USER
    )
    other = await images.food_image(
        FoodIdentity(name="ZA'ATAR ", name_key="za'atar"), USER
    )
    assert other.image_key == first.image_key


async def test_concurrent_requests_for_one_image_call_the_provider_once():
    store, provider = FakeStore(), FakeProvider(delay=0.05)
    images = service(store, provider)
    dish = recipe()
    results = await asyncio.gather(
        *(images.recipe_image(dish, USER, generate=True) for _ in range(6))
    )
    assert {result.status for result in results} == {"ready"}
    assert len({result.url for result in results}) == 1
    assert len(provider.prompts) == 1 and store.spent == 60


async def test_a_cancelled_caller_does_not_abandon_the_generation():
    store, provider = FakeStore(), FakeProvider(delay=0.05)
    images = service(store, provider)
    dish = recipe()
    caller = asyncio.create_task(images.recipe_image(dish, USER, generate=True))
    await asyncio.sleep(0.01)
    caller.cancel()
    later = await images.recipe_image(dish, USER, generate=True)
    assert later.status == "ready" and len(provider.prompts) == 1


async def test_generation_running_elsewhere_is_reported_pending():
    store = FakeStore()
    images = service(store)
    dish = recipe()
    await store.claim("recipe", images.recipe_key(dish), OTHER, POLICY.limits("recipe"))
    result = await images.recipe_image(dish, USER, generate=True)
    assert (result.status, result.url, result.reason) == ("pending", None, None)


async def test_disabled_generation_serves_cached_images_and_never_claims():
    store, provider = FakeStore(), FakeProvider()
    dish = recipe()
    await service(store, provider).recipe_image(dish, USER, generate=True)
    disabled = service(store, provider, enabled=False)
    assert (await disabled.recipe_image(dish, USER, generate=True)).status == "ready"
    missing = await disabled.recipe_image(recipe("Soup"), USER, generate=True)
    assert (missing.status, missing.reason) == ("unavailable", "disabled")
    assert len(provider.prompts) == 1 and store.spent == 60


async def test_provider_without_credentials_refunds_the_reservation():
    store = FakeStore()
    result = await service(store, FakeProvider(None)).recipe_image(
        recipe(), USER, generate=True
    )
    assert (result.status, result.reason) == ("unavailable", "disabled")
    assert store.spent == 0


async def test_budget_at_cap_returns_placeholder_without_a_provider_call():
    store, provider = FakeStore(spent=41), FakeProvider()
    result = await service(store, provider).recipe_image(recipe(), USER, generate=True)
    assert (result.status, result.reason) == ("unavailable", "budget_exhausted")
    assert provider.prompts == [] and store.spent == 41


async def test_budget_exactly_at_cap_still_generates():
    store = FakeStore(spent=40)
    assert (
        await service(store).recipe_image(recipe(), USER, generate=True)
    ).status == "ready"
    assert store.spent == 100


async def test_provider_error_response_is_refunded_and_not_retried_in_request():
    store = FakeStore()
    provider = FakeProvider(ProviderError("rate limited", status_code=429), png())
    result = await service(store, provider).recipe_image(recipe(), USER, generate=True)
    assert (result.status, result.reason) == ("unavailable", "failed")
    assert len(provider.prompts) == 1 and store.spent == 0


@pytest.mark.parametrize(
    "failure",
    [ProviderError("bad image after 200"), ProviderError("connection reset")],
)
async def test_failure_that_may_have_billed_keeps_the_charge(failure):
    store = FakeStore()
    result = await service(store, FakeProvider(failure)).recipe_image(
        recipe(), USER, generate=True
    )
    assert result.reason == "failed" and store.spent == 60


async def test_timeout_keeps_the_charge():
    store = FakeStore()
    images = service(store, FakeProvider(delay=1), timeout_seconds=0.01)
    result = await images.recipe_image(recipe(), USER, generate=True)
    assert result.reason == "failed" and store.spent == 60


async def test_upload_failure_after_billing_keeps_the_charge():
    store = FakeStore()
    store.fail_upload = True
    result = await service(store).recipe_image(recipe(), USER, generate=True)
    assert result.reason == "failed" and store.spent == 60


async def test_failed_image_retries_once_after_cooldown_then_stops():
    store = FakeStore()
    provider = FakeProvider(ProviderError("reset"), ProviderError("reset"), png())
    images = service(store, provider, monthly_cap_microusd=1000)
    dish = recipe()
    assert (await images.recipe_image(dish, USER, generate=True)).reason == "failed"
    assert (await images.recipe_image(dish, USER, generate=True)).reason == "failed"
    assert len(provider.prompts) == 1
    store.cooled_down = True
    assert (await images.recipe_image(dish, USER, generate=True)).reason == "failed"
    assert (await images.recipe_image(dish, USER, generate=True)).reason == "failed"
    assert len(provider.prompts) == 2 and store.spent == 120


async def test_prompt_over_the_provider_limit_is_never_claimed():
    store, provider = FakeStore(), FakeProvider()
    many = [
        {"name": f"spice {i} " + "x" * 70, "use_amount": 1, "unit": "g"}
        for i in range(120)
    ]
    result = await service(store, provider).recipe_image(
        recipe(ingredients=many), USER, generate=True
    )
    assert (result.status, result.reason) == ("unavailable", "failed")
    assert provider.prompts == [] and store.spent == 0


async def test_generation_is_charged_to_the_requester():
    store = FakeStore()
    await service(store).recipe_image(recipe(), USER, generate=True)
    assert store.requesters == [USER]


async def test_cache_only_request_serves_a_stored_image_and_never_claims():
    store, provider = FakeStore(), FakeProvider()
    images = service(store, provider)
    dish = recipe()
    await images.recipe_image(dish, USER, generate=True)
    saved = await images.recipe_image(dish, OTHER, generate=False)
    assert saved.status == "ready"
    missing = await images.recipe_image(recipe("Soup"), OTHER, generate=False)
    assert (missing.status, missing.reason) == ("unavailable", "disabled")
    assert store.requesters == [USER] and len(provider.prompts) == 1


async def test_refunded_failure_does_not_use_up_attempts():
    store = FakeStore()
    store.cooled_down = True
    error = ProviderError("unavailable", status_code=503)
    provider = FakeProvider(error, error, error, png())
    images = service(store, provider)
    dish = recipe()
    for _ in range(3):
        assert (await images.recipe_image(dish, USER, generate=True)).reason == "failed"
    assert (await images.recipe_image(dish, USER, generate=True)).status == "ready"
    assert store.spent == 60


@pytest.mark.parametrize(
    "overrides, enabled",
    [
        ({}, False),
        ({"image_generation_enabled": True}, True),
        ({"image_generation_enabled": True, "openai_api_key": ""}, False),
        (
            {
                "image_generation_enabled": True,
                "image_generation_monthly_cap_microusd": 0,
            },
            False,
        ),
        (
            {
                "image_generation_enabled": True,
                "image_generation_user_monthly_cap_microusd": 0,
            },
            False,
        ),
    ],
)
async def test_generation_needs_the_switch_a_key_and_positive_caps(overrides, enabled):
    settings = Settings(_env_file=None, **{"openai_api_key": "test-key", **overrides})
    assert ImagePolicy.from_settings(settings).enabled is enabled
