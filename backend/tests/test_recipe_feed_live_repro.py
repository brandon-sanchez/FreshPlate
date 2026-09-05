"""Live reproduction loop for the intermittent post-loader feed error (#42).

This is an on-demand diagnostic, not a CI test: it drives the real app
in-process against live Gemini and live Supabase, exactly as the mobile
client does when the full-screen loader runs. It is skipped unless
RUN_LIVE_FEED_REPRO=1 so the normal suite stays offline.

Red condition mirrors the app's error-with-retry state: the session POST
returns non-200, fails at transport, or exceeds the 35s client timeout.
"""

from __future__ import annotations

import asyncio
import json
import os
import time
from contextlib import asynccontextmanager
from datetime import date, timedelta

import httpx
import pytest

from app.api.recipes import get_recipe_feed_store
from app.main import create_app
from app.services.recipe_feed_store import SupabaseRecipeFeedStore

pytestmark = pytest.mark.skipif(
    os.environ.get("RUN_LIVE_FEED_REPRO") != "1",
    reason="Live Gemini + Supabase loop; run explicitly with RUN_LIVE_FEED_REPRO=1",
)

TEST_USER_ID = "47b20c34-d888-4aae-8898-fe29c33d17bc"
CLIENT_TIMEOUT_S = 35.0
RUNS = int(os.environ.get("FEED_REPRO_RUNS", "6"))
RESULTS_PATH = os.environ.get("FEED_REPRO_OUT", "")

PAYLOAD = {
    "inventory": [
        {
            "id": "itm-01",
            "name": "Chicken breast",
            "quantity": 2,
            "unit": "lb",
            "expiration_date": (date.today() + timedelta(days=2)).isoformat(),
        },
        {
            "id": "itm-02",
            "name": "Broccoli",
            "quantity": 1,
            "unit": "head",
            "expiration_date": (date.today() + timedelta(days=3)).isoformat(),
        },
        {
            "id": "itm-03",
            "name": "Cheddar cheese",
            "quantity": 8,
            "unit": "oz",
            "expiration_date": (date.today() + timedelta(days=16)).isoformat(),
        },
        {
            "id": "itm-04",
            "name": "Eggs",
            "quantity": 10,
            "unit": "item",
            "expiration_date": (date.today() + timedelta(days=14)).isoformat(),
        },
        {
            "id": "itm-05",
            "name": "Milk",
            "quantity": 1,
            "unit": "quart",
            "expiration_date": (date.today() + timedelta(days=4)).isoformat(),
        },
        {
            "id": "itm-06",
            "name": "Rice",
            "quantity": 2,
            "unit": "lb",
            "expiration_date": None,
        },
        {
            "id": "itm-07",
            "name": "Onion",
            "quantity": 3,
            "unit": "item",
            "expiration_date": None,
        },
        {
            "id": "itm-08",
            "name": "Garlic",
            "quantity": 1,
            "unit": "bulb",
            "expiration_date": None,
        },
        {
            "id": "itm-09",
            "name": "Bell pepper",
            "quantity": 2,
            "unit": "item",
            "expiration_date": (date.today() + timedelta(days=5)).isoformat(),
        },
        {
            "id": "itm-10",
            "name": "Tortillas",
            "quantity": 8,
            "unit": "item",
            "expiration_date": (date.today() + timedelta(days=11)).isoformat(),
        },
    ],
    "preferences": {"meal": "dinner", "time": "under 30 minutes"},
}


@asynccontextmanager
async def _live_client(app):
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            yield client


async def _post_with_deadline(client, path, **kwargs):
    """Cancel the in-process request at the same deadline as the mobile client."""
    return await asyncio.wait_for(client.post(path, **kwargs), timeout=CLIENT_TIMEOUT_S)


class BackendDiagnosticStore(SupabaseRecipeFeedStore):
    """Use backend credentials for live reads when Auth is mocked in-process."""

    async def _request(self, *args, **kwargs):
        kwargs["trusted"] = True
        return await super()._request(*args, **kwargs)


def _service_store() -> SupabaseRecipeFeedStore:
    return BackendDiagnosticStore("")


@pytest.mark.asyncio
async def test_feed_burst_loop_mirrors_app_prefetch(signing_key, patch_jwks) -> None:
    """Mirror the app: session POST, then eager page fetches to the pool target.

    The mobile hook fires a page request immediately after the first render
    (ready-pool target 8), so real usage is a burst of 2+ generation runs.
    Each burst is one simulated loader run; red mirrors the loader error.
    """
    patch_jwks([signing_key])
    token = signing_key.sign(sub=TEST_USER_ID)
    app = create_app()
    app.dependency_overrides[get_recipe_feed_store] = _service_store

    bursts = int(os.environ.get("FEED_REPRO_BURSTS", "4"))
    rows: list[dict] = []
    async with _live_client(app) as client:
        for burst in range(bursts):
            started = time.monotonic()
            row: dict = {"burst": burst, "kind": "session"}
            try:
                response = await _post_with_deadline(
                    client,
                    "/api/recipes/sessions",
                    json=PAYLOAD,
                    headers={"Authorization": f"Bearer {token}"},
                )
                row["status"] = response.status_code
                row["latency_s"] = round(time.monotonic() - started, 2)
                body = response.json()
                if response.status_code != 200:
                    row["body"] = body
                    row["verdict"] = "RED"
                    rows.append(row)
                    print(json.dumps(row), flush=True)
                    continue
                data = body["data"]
                row["recipes"] = len(data["recipes"])
                row["verdict"] = "GREEN"
                rows.append(row)
                print(json.dumps(row), flush=True)

                pool = len(data["recipes"])
                cursor = data["next_cursor"]
                pages = 0
                while cursor is not None and pool < 8 and pages < 4:
                    page_started = time.monotonic()
                    page_row: dict = {
                        "burst": burst,
                        "kind": f"page-{pages}",
                    }
                    page_response = await _post_with_deadline(
                        client,
                        f"/api/recipes/sessions/{data['session_id']}/pages",
                        json={"cursor": cursor, "limit": 5},
                        headers={"Authorization": f"Bearer {token}"},
                    )
                    page_row["status"] = page_response.status_code
                    page_row["latency_s"] = round(time.monotonic() - page_started, 2)
                    page_body = page_response.json()
                    if page_response.status_code == 200:
                        page_data = page_body["data"]
                        page_row["recipes"] = len(page_data["recipes"])
                        pool += len(page_data["recipes"])
                        cursor = page_data["next_cursor"]
                        page_row["verdict"] = "GREEN"
                    else:
                        page_row["body"] = page_body
                        page_row["verdict"] = "RED"
                        cursor = None
                    pages += 1
                    rows.append(page_row)
                    print(json.dumps(page_row), flush=True)
            except Exception as exc:
                row["status"] = "transport-error"
                row["error"] = repr(exc)
                row["latency_s"] = round(time.monotonic() - started, 2)
                row["verdict"] = "RED"
                rows.append(row)
                print(json.dumps(row), flush=True)

    if RESULTS_PATH:
        with open(RESULTS_PATH, "a") as out:
            for row in rows:
                out.write(json.dumps(row) + "\n")

    reds = [row for row in rows if row["verdict"] == "RED"]
    assert not reds, f"{len(reds)}/{len(rows)} requests went red: {reds}"


def test_store_probe_creates_and_reads_session() -> None:
    """Isolate the persistence seam: one create + read against live Supabase."""
    from uuid import uuid4

    from app.services.recipe_feed_store import (
        RecipeFeedSession,
        RecipeFeedStoreError,
    )

    store = _service_store()
    session = RecipeFeedSession(
        id=uuid4(),
        user_id=TEST_USER_ID,
        inventory=[],
        preferences={},
        usable_items=[{"id": "itm-01", "name": "Chicken breast"}],
        retrieved_recipes=[],
        exclude_titles=[],
        candidate_count=0,
        generation_runs=1,
        has_more=True,
    )
    try:
        asyncio.run(store.create_session(session))
    except RecipeFeedStoreError as exc:
        print(f"STORE-PROBE create failed: {exc!r} cause={exc.__cause__!r}")
        raise
    fetched = asyncio.run(store.get_session(TEST_USER_ID, session.id))
    print(f"STORE-PROBE ok, fetched: {fetched is not None}")


@pytest.mark.asyncio
async def test_feed_session_loop_never_ends_in_error(signing_key, patch_jwks) -> None:
    patch_jwks([signing_key])
    token = signing_key.sign(sub=TEST_USER_ID)

    app = create_app()
    app.dependency_overrides[get_recipe_feed_store] = _service_store

    rows: list[dict] = []
    async with _live_client(app) as client:
        for index in range(RUNS):
            started = time.monotonic()
            row: dict = {"run": index}
            try:
                response = await _post_with_deadline(
                    client,
                    "/api/recipes/sessions",
                    json=PAYLOAD,
                    headers={"Authorization": f"Bearer {token}"},
                )
                row["status"] = response.status_code
                row["latency_s"] = round(time.monotonic() - started, 2)
                body = response.json()
                if response.status_code == 200:
                    row["recipes"] = len(body["data"]["recipes"])
                    row["has_more"] = body["data"]["has_more"]
                else:
                    row["body"] = body
            except Exception as exc:
                row["status"] = "transport-error"
                row["error"] = repr(exc)
                row["latency_s"] = round(time.monotonic() - started, 2)
            green = (
                row.get("status") == 200
                and row.get("latency_s", CLIENT_TIMEOUT_S) < CLIENT_TIMEOUT_S
            )
            row["verdict"] = "GREEN" if green else "RED"
            rows.append(row)
            print(json.dumps(row), flush=True)

    if RESULTS_PATH:
        with open(RESULTS_PATH, "a") as out:
            for row in rows:
                out.write(json.dumps(row) + "\n")

    reds = [row for row in rows if row["verdict"] == "RED"]
    assert not reds, f"{len(reds)}/{RUNS} runs ended in the loader error state: {reds}"
