"""Load the eval dataset: the kitchens and requests the recipe pipeline is scored on."""

from __future__ import annotations

from collections import Counter
from pathlib import Path
from typing import Annotated

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    TypeAdapter,
    ValidationError,
    field_validator,
)

from app.ai.agents.kitchen_basics import KitchenBasics
from app.inventory.food_facts import FoodLine

DATASET_PATH = Path(__file__).with_name("dataset.json")

DEFAULT_KITCHEN_BASICS = KitchenBasics(
    ("Salt", "Black pepper", "Neutral oil", "Olive oil", "Water")
)
"""The basics every eval kitchen has.

Mirrors ``public.default_kitchen_basics()`` in
``supabase/migrations/20261116140000_add_kitchen_basics.sql``, so each case
cooks with what a new household starts with.
"""

PREFERENCE_KEYS = frozenset({"meal", "time", "mood", "cuisine", "diet", "occasion"})
"""The questions the app's preference flow asks.

Mirrors ``RECIPE_PREFERENCE_KEYS`` in ``mobile/types/recipes.ts``, so a case
can only send answers the app can send.
"""


class EvalCaseError(ValueError):
    """The dataset file is missing, malformed, or has a duplicate case name."""


class EvalCase(BaseModel):
    """One kitchen and what its cook asked for.

    Attributes:
        name: A unique label for the case, such as "tomato pasta".
        preferences: The cook's answers, keyed by preference question. The
            values are the app's own option labels, such as "Vegan", or free
            text for ``occasion``.
        inventory: The kitchen's foods, as the recipe API reads them.
    """

    model_config = ConfigDict(extra="forbid", frozen=True)

    name: str = Field(min_length=1)
    preferences: dict[str, str]
    inventory: list[FoodLine] = Field(min_length=1)

    @field_validator("preferences")
    @classmethod
    def _known_questions(cls, preferences: dict[str, str]) -> dict[str, str]:
        unknown = sorted(set(preferences) - PREFERENCE_KEYS)
        if unknown:
            raise ValueError(f"unknown preference keys: {unknown}")
        return preferences


_CASES = TypeAdapter(Annotated[list[EvalCase], Field(min_length=1)])


def load_cases(path: Path = DATASET_PATH) -> list[EvalCase]:
    """Return the dataset's cases in file order.

    Raises:
        EvalCaseError: When the file can't be read, holds no case, has an
            invalid case, or has two cases with one name.
    """
    try:
        cases = _CASES.validate_json(path.read_bytes())
    except (OSError, ValidationError) as exc:
        raise EvalCaseError(f"Eval dataset {path} is invalid: {exc}") from exc
    repeated = [
        name for name, count in Counter(c.name for c in cases).items() if count > 1
    ]
    if repeated:
        raise EvalCaseError(f"Eval case names must be unique: {repeated}")
    return cases
