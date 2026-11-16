"""Decide whether a recipe request asks for a meal, a snack or a dessert."""

from __future__ import annotations

import re
from collections.abc import Mapping
from typing import Any, Literal

RequestedDish = Literal["meal", "snack", "dessert"]
"""The kind of dish a session asks for: a meal unless the cook asks for another."""

# Checked in order, so free text that asks for both gets a snack.
_DISH_WORDS: tuple[tuple[RequestedDish, re.Pattern[str]], ...] = (
    ("snack", re.compile(r"\bsnacks?\b", flags=re.IGNORECASE)),
    (
        "dessert",
        re.compile(
            r"\b(?:desserts?|sweets|sweet treats?|something sweet)\b",
            flags=re.IGNORECASE,
        ),
    ),
)
_MEAL_WORD = re.compile(
    r"\b(?:breakfast|brunch|lunch|dinner|supper|meal)s?\b", flags=re.IGNORECASE
)
_CLAUSE_BREAK = re.compile(r"[,.;:!?()]|\bthen\b", flags=re.IGNORECASE)
_NEGATION = re.compile(
    r"\b(?:no|not|without|skip|never|nothing|don[’']?t|doesn[’']?t)\b|-free\b",
    flags=re.IGNORECASE,
)


def requested_dish(preferences: Mapping[str, Any]) -> RequestedDish:
    """Return the kind of dish the session's answers ask for.

    The app's "Which meal?" answer (``preferences["meal"]``) decides when it
    is set: "Snack" is a snack, "Dessert" is a dessert and every other
    answer is a meal. Without it, the free-text answer
    (``preferences["occasion"]``) decides, and any doubt reads as a meal:
    text that names a meal ("dinner and dessert") is a meal, and a snack or
    dessert word counts only in a clause with no negation, so "no snack or
    dessert" and "skip dessert" are meals.
    """
    meal = preferences.get("meal")
    if isinstance(meal, str) and meal.strip():
        answer = meal.strip().casefold()
        return next((dish for dish, _ in _DISH_WORDS if dish == answer), "meal")
    occasion = preferences.get("occasion")
    if not isinstance(occasion, str) or _MEAL_WORD.search(occasion):
        return "meal"
    clauses = [
        clause
        for clause in _CLAUSE_BREAK.split(occasion)
        if not _NEGATION.search(clause)
    ]
    for dish, word in _DISH_WORDS:
        if any(word.search(clause) for clause in clauses):
            return dish
    return "meal"
