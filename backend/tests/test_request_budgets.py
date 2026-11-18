"""Checks that each request budget fits its caller's timeout on a cold start."""

import re
from pathlib import Path

import pytest

from app.core.config import Settings

_FEED_API = Path(__file__).parents[2] / "mobile" / "lib" / "recipe-feed-api.ts"
# Time a request spends outside its budget when it starts a Lambda instance.
# docs/deployment.md explains each figure.
_INSTANCE_START_SECONDS = 4.0
_FIRST_JWKS_FETCH_SECONDS = 0.5
_PHONE_NETWORK_SECONDS = 1.0
_TRACE_FLUSH_SECONDS = 1.0
_MARGIN_SECONDS = 1.5
_COLD_START_SECONDS = (
    _INSTANCE_START_SECONDS + _FIRST_JWKS_FETCH_SECONDS + _PHONE_NETWORK_SECONDS
)
# Mirrors _TIMEOUT in infra/freshplate_infra/api_stack.py.
_LAMBDA_TIMEOUT_SECONDS = 150


def _app_timeout_seconds(name: str) -> float:
    match = re.search(rf"export const {name} = ([\d_]+);", _FEED_API.read_text())
    assert match, f"{name} not found in {_FEED_API}"
    return int(match[1].replace("_", "")) / 1000


@pytest.mark.parametrize(
    ("budget", "timeout"),
    [
        ("recipe_feed_initial_budget_seconds", "RECIPE_FEED_REQUEST_TIMEOUT_MS"),
        ("recipe_feed_page_budget_seconds", "RECIPE_FEED_REQUEST_TIMEOUT_MS"),
    ],
)
def test_a_cold_feed_request_answers_before_the_app_gives_up(budget, timeout):
    seconds = getattr(Settings(_env_file=None), budget)
    outside = _COLD_START_SECONDS + _TRACE_FLUSH_SECONDS + _MARGIN_SECONDS
    assert seconds + outside <= _app_timeout_seconds(timeout)


def test_a_cold_feed_restore_answers_before_the_app_gives_up():
    seconds = Settings(_env_file=None).recipe_feed_restore_budget_seconds
    outside = _COLD_START_SECONDS + _MARGIN_SECONDS
    assert seconds + outside <= _app_timeout_seconds("RECIPE_FEED_RESTORE_TIMEOUT_MS")


def test_a_cold_photo_request_ends_before_the_function_times_out():
    seconds = Settings(_env_file=None).image_generation_timeout_seconds
    supabase_calls = 1.0
    outside = _COLD_START_SECONDS + supabase_calls + _MARGIN_SECONDS
    assert seconds + outside <= _LAMBDA_TIMEOUT_SECONDS
