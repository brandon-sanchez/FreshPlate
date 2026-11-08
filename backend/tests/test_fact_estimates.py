"""Deciding which foods need estimated facts, and cleaning the model's answer."""

# ruff: noqa: E501

from __future__ import annotations

from decimal import Decimal

import pytest

from app.ai.llm.errors import ProviderError
from app.ai.llm.retry import PipelineDeadline
from app.inventory.fact_estimates import (
    ProfileEstimate,
    estimate_food_facts,
    needs_estimate,
)
from tests.estimate_support import (
    RecordingProvider,
    food_row,
    unmatched_row,
)

D = Decimal
RICE = {
    "name": "Rice",
    "name_key": "rice",
    "stock_base": "g",
    "each_label": None,
    "profile_key": "rice",
    "profile_g_per_ml": 0.78,
    "profile_unit_grams": {"cup": 185},
}


def deadline() -> PipelineDeadline:
    return PipelineDeadline(30)


@pytest.mark.parametrize(
    ("row", "expected"),
    [
        pytest.param(unmatched_row(), True, id="no profile"),
        pytest.param(food_row(), True, id="garlic profile knows no head"),
        pytest.param(food_row(profile_estimated_at="2026-11-08T00:00:00Z"), False, id="already estimated"),
        pytest.param(food_row(grams_per_each=45), False, id="household head weight"),
        pytest.param(food_row(profile_unit_grams={"clove": 3, "bulb": 40}), False, id="profile head weight"),
        pytest.param(food_row(profile_unit_grams={"each": 40}), False, id="profile each weight"),
        pytest.param(food_row(profile_g_per_ml=None, grams_per_each=45), True, id="no density"),
        pytest.param(food_row(profile_g_per_ml=None, g_per_ml=0.6, grams_per_each=45), False, id="household density"),
        pytest.param(food_row(ml_per_each=60), False, id="household volume per head with a density"),
        pytest.param(food_row(**RICE), True, id="weighed food without each"),
        pytest.param(food_row(**{**RICE, "profile_unit_grams": {"each": 0.02}}), False, id="weighed food with each"),
        pytest.param(food_row(each_label="Containers"), False, id="package size is the household's to give"),
        pytest.param(food_row(each_label="jar", profile_g_per_ml=None), True, id="package food without density"),
    ],
)  # fmt: skip
def test_needs_estimate(row, expected):
    assert needs_estimate(row) is expected


@pytest.mark.asyncio
async def test_matched_food_keeps_its_profile_and_gets_clean_unit_weights():
    provider = RecordingProvider(
        [
            {
                "food": "garlic bulb",
                "g_per_ml": 0.6,
                "unit_weights": [
                    {"unit": "Bulbs", "grams": 40},
                    {"unit": "cloves", "grams": 4.5},
                    {"unit": "clove", "grams": 5},
                    {"unit": "ounce", "grams": 28},
                    {"unit": "Grams", "grams": 1},
                    {"unit": "tbsp", "grams": 8.5},
                    {"unit": "tablespoons", "grams": 8.5},
                ],
            }
        ]
    )
    estimate = await estimate_food_facts([food_row()], provider, deadline=deadline())
    assert estimate == ProfileEstimate(
        profile_name="garlic",
        estimated_by="gemini-3.6-flash",
        g_per_ml=D("0.6"),
        unit_grams={"head": D("40"), "tbsp": D("8.5")},
    )
    assert provider.prompts == [
        {
            "food": "garlic",
            "known_profile": "garlic",
            "counted_in": ["head"],
            "units_wanted": ["head"],
        }
    ]


@pytest.mark.asyncio
async def test_unmatched_food_takes_the_generic_name_from_the_model():
    provider = RecordingProvider(
        [{"food": "peanut butter", "g_per_ml": None, "unit_weights": []}]
    )
    estimate = await estimate_food_facts(
        [unmatched_row()], provider, deadline=deadline()
    )
    assert estimate.profile_name == "peanut butter"
    assert estimate.g_per_ml is None and estimate.unit_grams == {}
    assert provider.prompts[0]["known_profile"] is None
    assert provider.prompts[0]["units_wanted"] == []


@pytest.mark.asyncio
async def test_package_sizes_are_never_asked_for_or_kept():
    provider = RecordingProvider(
        [
            {
                "food": "chicken tinga",
                "g_per_ml": 1.05,
                "unit_weights": [
                    {"unit": "containers", "grams": 450},
                    {"unit": "jar", "grams": 500},
                    {"unit": "cup", "grams": 240},
                ],
            }
        ]
    )
    estimate = await estimate_food_facts(
        [unmatched_row(stock_base="each", each_label="container")],
        provider,
        deadline=deadline(),
    )
    assert estimate.unit_grams == {"cup": D("240")}
    assert provider.prompts[0]["counted_in"] == []
    assert provider.prompts[0]["units_wanted"] == []


@pytest.mark.asyncio
async def test_a_food_with_a_profile_is_described_by_the_profile_not_its_household_name():
    provider = RecordingProvider([{"food": "chicken tinga"}])
    pinned = food_row(name="Maria's chicken tinga", profile_key="chicken tinga")
    await estimate_food_facts([pinned], provider, deadline=deadline())
    assert provider.prompts[0]["food"] == "chicken tinga"


@pytest.mark.asyncio
async def test_provider_failure_propagates():
    provider = RecordingProvider([ProviderError("Gemini generation failed")])
    with pytest.raises(ProviderError):
        await estimate_food_facts([food_row()], provider, deadline=deadline())


@pytest.mark.asyncio
async def test_out_of_range_weights_fail_as_provider_errors():
    provider = RecordingProvider(
        [{"food": "garlic", "unit_weights": [{"unit": "head", "grams": 0}]}]
    )
    with pytest.raises(ProviderError):
        await estimate_food_facts([food_row()], provider, deadline=deadline())


@pytest.mark.asyncio
async def test_expired_deadline_makes_no_model_call():
    now = [0.0]
    expired = PipelineDeadline(1, clock=lambda: now[0])
    now[0] = 2.0
    provider = RecordingProvider([{"food": "garlic"}])
    with pytest.raises(ProviderError):
        await estimate_food_facts([food_row()], provider, deadline=expired)
    assert provider.prompts == []
