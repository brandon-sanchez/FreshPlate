"""Build image prompts for recipe photos and ingredient thumbnails."""

from __future__ import annotations

import re

from app.ai.agents.models import Recipe

_MAX_NAME_CHARS = 80
_NON_WORD = re.compile(r"[\W_]+")

_RECIPE_STYLE = (
    "Realistic food photograph of the finished dish described below, as served. "
    "Natural window light, true-to-life food texture, professional plating on a "
    "simple plate, three-quarter overhead angle, shallow depth of field. "
    "Show only the listed ingredients. Do not add sides, "
    "garnishes, sauces, drinks, utensils with food, or any ingredient that is not "
    "listed. No text, labels, logos, hands or people."
)

_INGREDIENT_STYLE = (
    "Realistic product photograph of {name}, as a home cook would buy it, centered "
    "and filling most of the frame against a plain light neutral background. Soft "
    "natural light, true-to-life color and texture. Only {name}: no other foods, "
    "packaging text, labels, logos, hands or people."
)


def recipe_photo_subject(recipe: Recipe) -> tuple[str, list[str]]:
    """Return what a recipe photo depicts: the dish title and its ingredients.

    Both are normalized: case-folded, with punctuation, underscores and runs
    of whitespace collapsed to single spaces. The ingredients are a sorted
    set of names, so their order, duplicates, amounts and units drop out.
    Steps are left out too. The photo cache key and the photo prompt are both
    built from this one value, so every recipe that shares a cached photo
    would have produced the same prompt.
    """
    title = _normalized(recipe.title)
    ingredients = sorted({_normalized(item.name) for item in recipe.ingredients})
    return title, ingredients


def recipe_image_prompt(recipe: Recipe) -> str:
    """Return the photo prompt for a validated recipe.

    The prompt names only the dish title and its set of ingredients, from
    `recipe_photo_subject`. Amounts and steps are left out because one
    photo serves every recipe with the same title and ingredients, in any
    household.
    """
    title, ingredients = recipe_photo_subject(recipe)
    lines = [_RECIPE_STYLE, "", f"Dish: {_clip(title)}", "Ingredients:"]
    lines += [f"- {_clip(name)}" for name in ingredients]
    return "\n".join(lines)


def ingredient_image_prompt(name: str) -> str:
    """Return the thumbnail prompt for one ingredient, by its display name."""
    return _INGREDIENT_STYLE.format(name=_clip(name))


def _normalized(text: str) -> str:
    return " ".join(_NON_WORD.sub(" ", text.casefold()).split())


def _clip(text: str) -> str:
    return " ".join(text.split())[:_MAX_NAME_CHARS]
