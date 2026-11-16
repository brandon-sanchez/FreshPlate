"""Recipe photo prompts describe the finished dish, not stored groceries."""

from __future__ import annotations

import pytest

from app.ai.agents.models import Recipe
from app.ai.images.prompts import recipe_image_prompt
from app.services.image_service import ImageService

# The photo key of `_omelet("Eggs", "Frozen peas")`. A different value means
# every cached recipe photo gets a new key and is generated and paid for again.
_OMELET_PHOTO_KEY = "d657c9ee2f1b9257d42db48d581f3d87809cfc13b5ed93c49947638bcb8762e8"


def _omelet(*names: str) -> Recipe:
    return Recipe.model_validate(
        {
            "title": "Pea and herb omelet",
            "cook_time_minutes": 10,
            "servings": 1,
            "ingredients": [
                {"name": name, "use_amount": 1, "unit": "each"} for name in names
            ],
            "steps": ["Whisk the eggs.", "Fold the omelet over the peas."],
        }
    )


def _ingredient_lines(prompt: str) -> list[str]:
    return [line[2:] for line in prompt.splitlines() if line.startswith("- ")]


@pytest.mark.parametrize(
    ("stored", "served"),
    [
        ("Frozen peas", "peas"),
        ("Canned chickpeas", "chickpeas"),
        ("tinned tomatoes", "tomatoes"),
        ("Jarred roasted red peppers", "roasted red peppers"),
        ("boxed spaghetti", "spaghetti"),
        ("Bagged spinach", "spinach"),
        ("bottled lemon juice", "lemon juice"),
        ("packaged tofu", "tofu"),
        ("raw shrimp", "shrimp"),
        ("Fresh-cut green beans", "green beans"),
        ("pre-washed kale", "kale"),
        ("Store-bought pesto", "pesto"),
        ("Frozen, canned corn", "corn"),
        ("Dried black beans", "black beans"),
        ("dried lentils", "lentils"),
        ("dried egg noodle", "egg noodle"),
        ("Dried porcini mushrooms", "porcini mushrooms"),
        ("Chickpeas in brine", "chickpeas"),
        ("tuna in olive oil", "tuna"),
        ("Peaches in heavy syrup", "peaches"),
        ("Dried cranberries", "dried cranberries"),
        ("dried oregano", "dried oregano"),
        ("Dried bean curd", "dried bean curd"),
        ("Sun-dried tomatoes", "sun dried tomatoes"),
        ("Frozen yogurt", "frozen yogurt"),
        ("frozen Greek yogurt", "frozen greek yogurt"),
        ("Raw sugar", "raw sugar"),
        ("raw honey", "raw honey"),
        ("Frozen", "frozen"),
        ("canned in water", "canned in water"),
        ("Eggs", "eggs"),
    ],
)
def test_prompt_drops_storage_and_packaging_words(stored, served):
    assert _ingredient_lines(recipe_image_prompt(_omelet(stored))) == [served]


def test_prompt_lists_served_names_sorted_and_merged():
    prompt = recipe_image_prompt(
        _omelet("Frozen peas", "Eggs", "Canned chickpeas", "peas")
    )
    assert _ingredient_lines(prompt) == ["chickpeas", "eggs", "peas"]


def test_prompt_says_how_the_dish_is_served():
    prompt = recipe_image_prompt(_omelet("Eggs", "Frozen peas"))
    assert (
        "Dish: pea and herb omelet, finished and plated the way it is usually served."
        in prompt.splitlines()
    )


def test_prompt_directs_a_cooked_plated_dish_without_packaging_or_ice():
    prompt = recipe_image_prompt(_omelet("Eggs", "Frozen peas")).casefold()
    for phrase in (
        "cooked, plated dish exactly as it is served",
        "cooked, thawed or fresh the way the recipe uses it",
        "no packaging",
        "no ice or frost",
        "no prep or cutting board scenes",
        "natural window light",
        "true-to-life food texture",
        "do not add sides, garnishes",
    ):
        assert phrase in prompt


def test_cache_key_uses_the_stored_title_and_ingredient_names():
    stored = _omelet("Eggs", "Frozen peas")
    assert ImageService.recipe_key(stored) == _OMELET_PHOTO_KEY
    # The prompt merges these two names but the key does not, because changing
    # the key would orphan every cached photo. Each recipe pays for its own.
    assert ImageService.recipe_key(stored) != ImageService.recipe_key(
        _omelet("Eggs", "peas")
    )
