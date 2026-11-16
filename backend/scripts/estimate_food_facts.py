"""List foods missing unit facts and, with --apply, estimate them with Gemini.

Usage:
    cd backend
    venv/bin/python -m scripts.estimate_food_facts            # list only
    venv/bin/python -m scripts.estimate_food_facts --apply --limit 20

Reads every household's foods through the backend Supabase key and finds the
ones whose shared profile is missing a density or a whole-item weight, or
that have no profile at all. Foods are grouped so each Gemini call covers
one profile, or one food name with no profile, however many households
stock it.

Without ``--apply`` it only prints the groups and makes no Gemini call, so a
stray run costs nothing. With ``--apply`` it makes one paid Gemini call per
group, up to ``--limit`` groups, and saves the estimate for every food in the
group. A group whose call fails is reported and skipped; rerunning retries it,
since only saved estimates stop a profile from being asked again. Exits 1
when any group failed.
"""

from __future__ import annotations

import argparse
import asyncio
from collections.abc import Iterable, Mapping
from typing import Any

from app.ai.llm.errors import ProviderError
from app.ai.llm.protocol import LLMProvider
from app.ai.llm.providers import GeminiProvider
from app.ai.llm.retry import PipelineDeadline
from app.inventory.fact_estimates import estimate_food_facts, needs_estimate
from app.services.food_profile_store import SupabaseFoodProfileStore


async def estimate_missing_facts(
    store: SupabaseFoodProfileStore,
    provider: LLMProvider | None,
    *,
    limit: int | None = None,
) -> int:
    """Print the foods missing facts and, given a provider, fill them.

    Args:
        store: Backend store to read foods from and save estimates to.
        provider: Language-model provider. ``None`` is a dry run that calls
            no model and writes nothing.
        limit: Most groups to list or estimate; ``None`` means all.

    Returns:
        The process exit code: 0, or 1 when any group's model call failed.

    Raises:
        FoodProfileStoreError: When reading foods or saving an estimate
            fails; the run stops there.
    """
    listed = await store.list_unestimated_food_facts()
    groups = _group(row for row in listed if needs_estimate(row))
    selected = list(groups.values())[:limit]
    print(
        f"{len(groups)} profile(s) or food name(s) need facts; showing {len(selected)}."
    )
    for rows in selected:
        print(f"  {_describe(rows)}")
    if provider is None:
        print("Dry run. Pass --apply to call Gemini for each group listed.")
        return 0

    failed = 0
    for rows in selected:
        try:
            estimate = await estimate_food_facts(
                rows, provider, deadline=PipelineDeadline.from_now()
            )
        except ProviderError as exc:
            failed += 1
            print(f"FAILED {_describe(rows)}: {exc}")
            continue
        resolved = {await store.save_estimate(row["id"], estimate) for row in rows}
        facts = {"g_per_ml": estimate.g_per_ml, **estimate.unit_grams}
        print(
            f"{rows[0]['name']} -> {', '.join(sorted(map(str, resolved)))}: "
            + ", ".join(f"{unit}={value}" for unit, value in facts.items())
        )
    return 1 if failed else 0


def _group(
    rows: Iterable[Mapping[str, Any]],
) -> dict[tuple[str, str], list[Mapping[str, Any]]]:
    groups: dict[tuple[str, str], list[Mapping[str, Any]]] = {}
    for row in rows:
        key = (
            ("profile", row["profile_key"])
            if row["profile_key"] is not None
            else ("name", row["name_key"])
        )
        groups.setdefault(key, []).append(row)
    return groups


def _describe(rows: list[Mapping[str, Any]]) -> str:
    profile = rows[0]["profile_key"]
    where = f"profile {profile!r}" if profile else "no profile"
    return f"{rows[0]['name']!r} ({where}, {len(rows)} food(s))"


def main(argv: list[str] | None = None) -> int:
    """Run the command line interface and return its exit code."""
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--apply", action="store_true", help="call Gemini and save the estimates"
    )
    parser.add_argument("--limit", type=int, help="most groups to list or estimate")
    args = parser.parse_args(argv)
    provider = GeminiProvider() if args.apply else None
    return asyncio.run(
        estimate_missing_facts(SupabaseFoodProfileStore(), provider, limit=args.limit)
    )


if __name__ == "__main__":
    raise SystemExit(main())
