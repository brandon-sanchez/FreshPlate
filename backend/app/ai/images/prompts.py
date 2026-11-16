"""Build image prompts for recipe photos and ingredient thumbnails."""

from __future__ import annotations

import re

from app.ai.agents.models import Recipe

_MAX_NAME_CHARS = 80
_NON_WORD = re.compile(r"[\W_]+")

_STORAGE_WORDS = frozenset(
    {"bagged", "bottled", "boxed", "canned", "jarred", "packaged", "tinned"}
)
_STORAGE_PHRASE = re.compile(r"\b(?:fresh cut|pre cut|pre washed|store bought)\b")
_PACKING_LIQUID = re.compile(r" in (?:\w+ )?(?:brine|juice|oil|syrup|water)$")
_COOKED_FROM_DRY = frozenset(
    {"bean", "chickpea", "lentil", "mushroom", "noodle", "pasta", "pea"}
)
_KEEPS_QUALIFIER = {
    "frozen": frozenset({"custard", "yogurt"}),
    "raw": frozenset({"honey", "sugar"}),
}

_RECIPE_STYLE = (
    "Realistic food photograph of the cooked, plated dish exactly as it is "
    "served, described below. Every ingredient appears cooked, thawed or fresh "
    "the way the recipe uses it. No packaging, no ice or frost, no prep or "
    "cutting board scenes. Natural window light, true-to-life food texture, "
    "professional plating on a simple plate or bowl that suits the dish, "
    "three-quarter overhead angle, shallow depth of field. "
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

    The prompt is built only from `recipe_photo_subject`, because one photo
    serves every recipe with the same title and ingredients, in any
    household. Amounts and steps are left out for the same reason.
    Ingredient names lose the words that say how a food was stored or
    bought, because the image model draws those literally, such as ice on
    frozen peas.
    """
    title, ingredients = recipe_photo_subject(recipe)
    served = sorted({_served_ingredient_name(name) for name in ingredients})
    lines = [
        _RECIPE_STYLE,
        "",
        f"Dish: {_clip(title)}, finished and plated the way it is usually served.",
        "Ingredients, as they appear in the finished dish:",
    ]
    lines += [f"- {_clip(name)}" for name in served]
    return "\n".join(lines)


def ingredient_image_prompt(name: str) -> str:
    """Return the thumbnail prompt for one ingredient, by its display name."""
    return _INGREDIENT_STYLE.format(name=_clip(name))


def _normalized(text: str) -> str:
    return " ".join(_NON_WORD.sub(" ", text.casefold()).split())


def _served_ingredient_name(name: str) -> str:
    """Return an ingredient name as it appears in a cooked, served dish.

    Removes storage and packaging words (`_STORAGE_WORDS`, `_STORAGE_PHRASE`)
    and a trailing packing liquid such as "in brine". "Frozen" and "raw" go
    too, except where they name the food, as in "frozen yogurt" or "raw
    sugar" (`_KEEPS_QUALIFIER`). "Dried" goes only when the food is one that
    recipes cook or soak (`_COOKED_FROM_DRY`). Dried fruit and herbs keep it
    because they stay dried in the dish. Each rule looks at the last word of
    the name, the food itself. A name made only of such words is returned
    normalized.
    """
    normalized = _normalized(name)
    words = _PACKING_LIQUID.sub("", _STORAGE_PHRASE.sub("", normalized)).split()
    food = words[-1].removesuffix("s") if words else ""
    kept = [word for word in words if not _is_storage_word(word, food)]
    return " ".join(kept) or normalized


def _is_storage_word(word: str, food: str) -> bool:
    if word == "dried":
        return food in _COOKED_FROM_DRY
    if word in _KEEPS_QUALIFIER:
        return food not in _KEEPS_QUALIFIER[word]
    return word in _STORAGE_WORDS


def _clip(text: str) -> str:
    return " ".join(text.split())[:_MAX_NAME_CHARS]
