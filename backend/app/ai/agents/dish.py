"""Decide whether a recipe request asks for a meal or a snack."""

from __future__ import annotations

import re
from collections.abc import Mapping
from typing import Any, Literal

RequestedDish = Literal["meal", "snack"]
"""The kind of dish a session asks for: a meal unless the cook asks for a snack."""

_SNACK_WORD = re.compile(r"\bsnacks?\b", flags=re.IGNORECASE)
_RULED_OUT_SNACK = re.compile(
    r"\b(?:no|not|without)\s+(?:an?\s+)?snacks?\b", flags=re.IGNORECASE
)


def requested_dish(preferences: Mapping[str, Any]) -> RequestedDish:
    """Return "snack" when the session asks for a snack, else "meal".

    The app's "Which meal?" answer (``preferences["meal"]``) decides when it
    is set: "Snack" is a snack and every other answer is a meal. Without
    it, the free-text answer (``preferences["occasion"]``) asks for a snack
    when it says "snack" or "snacks" outside a phrase that rules snacks
    out, such as "no snacks" or "not a snack".
    """
    meal = preferences.get("meal")
    if isinstance(meal, str) and meal.strip():
        return "snack" if meal.strip().casefold() == "snack" else "meal"
    occasion = preferences.get("occasion")
    if isinstance(occasion, str) and _SNACK_WORD.search(
        _RULED_OUT_SNACK.sub("", occasion)
    ):
        return "snack"
    return "meal"
