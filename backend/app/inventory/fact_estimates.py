"""Estimate a food's missing unit facts with a language model, once per profile.

The unit converter needs a density and a whole-item weight to move between
grams, millilitres and counted items. USDA covers neither for foods it does
not list, and leaves gaps in the profiles it does (garlic weighs a clove but
not a head). This module decides which ``food_facts`` rows have such a gap,
asks the model for typical values, and saves them as estimates on the shared
food profile, where every household reuses them and the converter reports any
amount that used them as ``Approximate``.
"""

from __future__ import annotations

import json
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from decimal import Decimal
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from app.ai.llm.errors import ProviderError
from app.ai.llm.protocol import LLMProvider
from app.ai.llm.retry import PipelineDeadline
from app.ai.prompts.loader import load_prompt
from app.inventory.food_facts import food_facts_from_row
from app.inventory.units import PACKAGE_WORDS, normalize_unit, table_unit


class _UnitWeight(BaseModel):
    """The model's weight for one unit of the food.

    Attributes:
        unit: A unit word as the model wrote it, e.g. ``"clove"``.
        grams: Grams in one of that unit.
    """

    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    unit: str = Field(min_length=1, max_length=30)
    grams: float = Field(gt=0, le=25_000)


class _FoodFactEstimate(BaseModel):
    """The model's structured answer for one food.

    Attributes:
        food: Generic food name with no brand or household words.
        g_per_ml: Density in grams per millilitre, or ``None`` when measuring
            the food by volume makes no sense or the model is unsure.
        unit_weights: Weights of the wanted units and a few common others.
    """

    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    food: str = Field(min_length=1, max_length=80)
    g_per_ml: float | None = Field(default=None, gt=0, le=5)
    unit_weights: list[_UnitWeight] = Field(default_factory=list, max_length=12)


@dataclass(frozen=True)
class ProfileEstimate:
    """Cleaned estimated facts, ready to save on a food profile.

    Attributes:
        profile_name: The profile the facts describe. For a food with a
            profile it is that profile's key; otherwise the model's generic
            food name, which the database normalizes and may match to an
            existing profile.
        g_per_ml: Density in grams per millilitre, or ``None`` when unknown.
        unit_grams: Grams per unit word, keyed by ``normalize_unit``. Mass
            units are never keys.
        estimated_by: Model id that produced the facts.
    """

    profile_name: str
    estimated_by: str
    g_per_ml: Decimal | None = None
    unit_grams: Mapping[str, Decimal] = field(default_factory=dict)


def needs_estimate(row: Mapping[str, Any]) -> bool:
    """Return whether a ``food_facts`` row has a gap worth one model call.

    A row needs an estimate when it has no profile, or when its profile was
    never estimated and the food lacks either a density (its own or the
    profile's) or a whole-item weight. A whole-item weight is the food's
    ``grams_per_each``, its ``ml_per_each`` with a density, or a profile
    weight for its counted unit or ``"each"``;
    for a food stocked by weight or volume it is the profile's ``"each"``. A
    food counted in packages (a jar, a container) never lacks a whole-item
    weight, because a package's size is the household's to give.

    Args:
        row: A ``food_facts`` row, including ``profile_estimated_at``.

    Raises:
        KeyError: When a needed column is missing.
        ValueError: When a fact in the row is invalid.
    """
    if row["profile_estimated_at"] is not None:
        return False
    facts = food_facts_from_row(row)
    profile = facts.profile
    if profile is None:
        return True
    has_density = facts.g_per_ml is not None or profile.g_per_ml is not None
    has_whole_item_weight = (
        facts.grams_per_each is not None
        or (facts.ml_per_each is not None and has_density)
        or facts.each_label in PACKAGE_WORDS
        or any(unit in profile.unit_grams for unit in ("each", facts.each_label))
    )
    return not (has_density and has_whole_item_weight)


async def estimate_food_facts(
    rows: Sequence[Mapping[str, Any]],
    provider: LLMProvider,
    *,
    deadline: PipelineDeadline,
) -> ProfileEstimate:
    """Ask the model for one food's typical unit facts and clean the answer.

    Makes one paid Gemini call through ``provider`` (with its retries) and
    writes nothing. Unit words are normalized, mass units are dropped since
    a gram weight of a gram unit says nothing, package words are dropped
    since a package's size is the household's to give, and a unit listed
    twice with different weights is dropped.

    Args:
        rows: ``food_facts`` rows of one food: either rows that share one
            profile, or rows with no profile that share one name. The model
            is asked for the weight of every counted unit among them. For
            rows with a profile, the model sees the profile key rather than
            a household's own food name.
        provider: The language-model provider.
        deadline: Shared budget for the call and its retries.

    Returns:
        The estimate, keyed to the rows' profile when they have one.

    Raises:
        ProviderError: When the model is unavailable, returns invalid output,
            or the deadline runs out. Callers report it as ``AI_UNAVAILABLE``.
    """
    template = load_prompt("estimate_food_facts")
    first = rows[0]
    labels = {food_facts_from_row(row).each_label for row in rows}
    items = {label for label in labels if label and label not in PACKAGE_WORDS}
    measures = {row["stock_base"] for row in rows if row["stock_base"] != "each"}
    request = {
        "food": first["profile_key"] or first["name"],
        "known_profile": first["profile_key"],
        "counted_in": sorted(measures | items),
        "units_wanted": sorted(items),
    }
    if deadline.expired:
        raise ProviderError("Food fact estimate deadline exhausted")
    answer = await provider.generate(
        json.dumps(request),
        response_model=_FoodFactEstimate,
        system_instruction=template.system,
        deadline=deadline,
        thinking=template.thinking,
    )
    if deadline.expired:
        raise ProviderError("Food fact estimate deadline exhausted")
    return ProfileEstimate(
        profile_name=first["profile_key"] or answer.food,
        estimated_by=template.model,
        g_per_ml=None if answer.g_per_ml is None else Decimal(str(answer.g_per_ml)),
        unit_grams=_unit_grams(answer.unit_weights),
    )


def _unit_grams(weights: Sequence[_UnitWeight]) -> dict[str, Decimal]:
    grams: dict[str, Decimal] = {}
    conflicting: set[str] = set()
    for weight in weights:
        unit = normalize_unit(weight.unit)
        measured = table_unit(unit)
        if unit in PACKAGE_WORDS or (measured is not None and measured[0] == "g"):
            continue
        value = Decimal(str(weight.grams))
        if grams.setdefault(unit, value) != value:
            conflicting.add(unit)
    return {unit: value for unit, value in grams.items() if unit not in conflicting}
