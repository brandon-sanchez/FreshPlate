"""The operator command that fills missing food facts."""

from __future__ import annotations

import pytest

from app.ai.llm.errors import ProviderError
from scripts.estimate_food_facts import estimate_missing_facts
from tests.estimate_support import (
    RecordingProvider,
    StoreServer,
    food_row,
    unmatched_row,
)

ROWS = [
    food_row(id="garlic-a"),
    food_row(id="garlic-b", name="garlic"),
    unmatched_row(id="pb-a"),
    unmatched_row(id="pb-b"),
    food_row(id="garlic-c", grams_per_each=45, profile_key="black garlic"),
]
GARLIC = {"food": "garlic", "unit_weights": [{"unit": "head", "grams": 40}]}
PEANUT_BUTTER = {"food": "peanut butter", "g_per_ml": 1.07}


@pytest.mark.asyncio
async def test_dry_run_lists_one_group_per_profile_or_name_and_calls_nothing(capsys):
    server = StoreServer(ROWS)
    assert await estimate_missing_facts(server.store(), None) == 0
    out = capsys.readouterr().out
    assert "2 profile(s) or food name(s) need facts" in out
    assert "'Garlic' (profile 'garlic', 2 food(s))" in out
    assert "(no profile, 2 food(s))" in out
    assert server.saves == []


@pytest.mark.asyncio
async def test_apply_makes_one_call_per_group_and_saves_every_food():
    server = StoreServer(ROWS)
    provider = RecordingProvider([GARLIC, PEANUT_BUTTER])
    assert await estimate_missing_facts(server.store(), provider) == 0
    assert len(provider.prompts) == 2
    assert [(save["p_food_id"], save["p_profile_name"]) for save in server.saves] == [
        ("garlic-a", "garlic"),
        ("garlic-b", "garlic"),
        ("pb-a", "peanut butter"),
        ("pb-b", "peanut butter"),
    ]


@pytest.mark.asyncio
async def test_a_failed_group_is_reported_and_the_run_continues(capsys):
    server = StoreServer(ROWS)
    provider = RecordingProvider(
        [ProviderError("Gemini generation failed"), PEANUT_BUTTER]
    )
    assert await estimate_missing_facts(server.store(), provider) == 1
    assert "FAILED 'Garlic'" in capsys.readouterr().out
    assert {save["p_food_id"] for save in server.saves} == {"pb-a", "pb-b"}


@pytest.mark.asyncio
async def test_limit_caps_the_groups_estimated():
    server = StoreServer(ROWS)
    provider = RecordingProvider([GARLIC])
    assert await estimate_missing_facts(server.store(), provider, limit=1) == 0
    assert len(provider.prompts) == 1
    assert {save["p_food_id"] for save in server.saves} == {"garlic-a", "garlic-b"}


@pytest.mark.asyncio
async def test_one_call_asks_for_every_unit_the_group_counts_in():
    rows = [food_row(id="garlic-a"), food_row(id="garlic-b", each_label="braid")]
    server = StoreServer(rows)
    provider = RecordingProvider([GARLIC])
    assert await estimate_missing_facts(server.store(), provider) == 0
    assert provider.prompts[0]["units_wanted"] == ["braid", "head"]
