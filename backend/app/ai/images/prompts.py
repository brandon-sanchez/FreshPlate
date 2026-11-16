"""Build image prompts for recipe photos and ingredient thumbnails."""

from __future__ import annotations

from app.ai.agents.models import Recipe, RecipeIngredient
from app.ai.images.openai import MAX_PROMPT_BYTES

_MAX_NAME_CHARS = 80

_RECIPE_STYLE = (
    "Realistic food photograph of the finished dish described below, as served. "
    "Natural window light, true-to-life food texture, professional plating on a "
    "simple plate, three-quarter overhead angle, shallow depth of field. "
    "Show only the listed ingredients in the amounts given. Do not add sides, "
    "garnishes, sauces, drinks, utensils with food, or any ingredient that is not "
    "listed. No text, labels, logos, hands or people."
)

_INGREDIENT_STYLE = (
    "Realistic product photograph of {name}, as a home cook would buy it, centered "
    "and filling most of the frame against a plain light neutral background. Soft "
    "natural light, true-to-life color and texture. Only {name}: no other foods, "
    "packaging text, labels, logos, hands or people."
)


def recipe_image_prompt(recipe: Recipe) -> str:
    """Return the photo prompt for a validated recipe.

    The prompt names the title, every ingredient with its amount, and the
    preparation steps, so the picture matches what the recipe makes. Steps are
    dropped from the end when the prompt would exceed the provider's limit.
    The title and ingredients are always kept.
    """
    lines = [_RECIPE_STYLE, "", f"Dish: {_clip(recipe.title)}", "Ingredients:"]
    lines += [f"- {_ingredient_line(item)}" for item in recipe.ingredients]
    lines.append("Preparation:")
    steps = [f"{index}. {step.strip()}" for index, step in enumerate(recipe.steps, 1)]
    while steps and len("\n".join(lines + steps).encode()) > MAX_PROMPT_BYTES:
        steps.pop()
    return "\n".join(lines + steps)


def ingredient_image_prompt(name: str) -> str:
    """Return the thumbnail prompt for one ingredient, by its display name."""
    return _INGREDIENT_STYLE.format(name=_clip(name))


def _ingredient_line(item: RecipeIngredient) -> str:
    name = _clip(item.name)
    if item.use_amount is None:
        return name
    amount = f"{item.use_amount:g}"
    return f"{amount} {_clip(item.unit)} {name}"


def _clip(text: str) -> str:
    return " ".join(text.split())[:_MAX_NAME_CHARS]
