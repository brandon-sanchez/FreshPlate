"""Keep a batch of separately generated recipes from repeating one dish.

Each recipe in a batch comes from its own provider call, and the calls can't
see each other. Two rules keep the batch varied: every call gets a different
direction (a lead ingredient and a dish format), and a title that names the
same dish as an earlier one in the batch is dropped.
"""

from __future__ import annotations

import re
from collections.abc import Sequence

from app.ai.agents.dish import RequestedDish
from app.ai.agents.models import Recipe
from app.ai.agents.state import UsableItem

# Category names come from the food_categories seed in
# supabase/migrations/20260329180000_create_inventory_tables.sql.
MAIN_COMPONENT_CATEGORIES = frozenset({"meat & seafood"})
_NEVER_LEAD_CATEGORIES = frozenset({"condiments", "beverages", "snacks"})
_NEVER_LEAD_SNACK_CATEGORIES = frozenset({"condiments", "beverages"})
_MEAL_FORMATS = (
    "a skillet, sauté or stir-fry cooked on the stovetop",
    "a pasta, rice, grain or noodle dish",
    "a soup, stew, curry or braise",
    "a roast, bake or sheet-pan dinner from the oven",
    "a hearty salad, grain bowl, wrap or sandwich",
    "a hash, frittata, fritter or savory pancake",
)
_SNACK_FORMATS = (
    "a dip or spread with something to scoop it",
    "a no-cook bite or plate, such as fruit with nut butter",
    "a toast, cracker or small sandwich",
    "a quick warm bite from the stovetop or oven",
)
_TITLE_LINKING_WORDS = frozenset(
    {"a", "an", "and", "the", "with", "over", "on", "in", "of", "for", "plus"}
)
_TITLE_WORD = re.compile(r"[^\W_]+", flags=re.UNICODE)
_SAME_DISH_WORD_OVERLAP = 0.75


def recipe_directions(
    usable_items: Sequence[UsableItem],
    count: int,
    *,
    offset: int = 0,
    dish: RequestedDish = "meal",
) -> list[str]:
    """Return one prompt direction per call, each with its own lead and format.

    For a meal, leads are taken in this order: meat and seafood, then the
    other foods, each group in the inventory's order, which puts expiring
    foods first. Condiments, drinks and snacks never lead unless the kitchen
    has nothing else. For a snack, any food except condiments and drinks can
    lead, in the inventory's order, and the formats are snack formats.
    Leads and formats repeat only when ``count`` is larger than the
    kitchen's leads or the formats. Each direction lets the model change the
    format, then the lead, because a lead such as garlic can't carry every
    format.

    Args:
        usable_items: The foods the batch may use, in analysis order.
        count: How many directions to return. Zero returns an empty list.
        offset: How many directions to skip in the lead and format cycles,
            so a later batch from the same kitchen starts elsewhere.
        dish: The kind of dish the session asks for.
    """
    if dish == "snack":
        leads = _snack_lead_names(usable_items)
        formats = _SNACK_FORMATS
    else:
        leads = _lead_names(usable_items)
        formats = _MEAL_FORMATS
    return [
        "\n".join(
            (
                "Direction for this recipe (separate requests write the other "
                "options at the same time, each with a different direction):",
                f"- Lead ingredient: {leads[position % len(leads)]}. Make it the "
                "star of the dish.",
                f"- Format: {formats[position % len(formats)]}.",
                f"If the kitchen can't make this direction into a real {dish}, "
                "change the format first, then the lead.",
            )
        )
        for position in range(offset, offset + count)
    ]


def drop_near_duplicate_titles(recipes: Sequence[Recipe]) -> list[Recipe]:
    """Return ``recipes`` without any whose title repeats an earlier dish.

    A title's content words are its words, case-folded, with a trailing
    plural "s" removed and linking words such as "with" and "over" left out.
    A recipe is dropped when at least three quarters of the words in its
    title and an earlier kept title together appear in both. The earlier
    recipe is kept. Titles are compared within ``recipes`` only.
    """
    kept: list[Recipe] = []
    kept_words: list[frozenset[str]] = []
    for recipe in recipes:
        words = _title_words(recipe.title)
        if any(_same_dish(words, earlier) for earlier in kept_words):
            continue
        kept.append(recipe)
        kept_words.append(words)
    return kept


def _lead_names(usable_items: Sequence[UsableItem]) -> list[str]:
    mains: list[str] = []
    others: list[str] = []
    for item in usable_items:
        category = _category(item)
        if category in MAIN_COMPONENT_CATEGORIES:
            mains.append(item["name"])
        elif category not in _NEVER_LEAD_CATEGORIES:
            others.append(item["name"])
    return mains + others or [item["name"] for item in usable_items]


def _snack_lead_names(usable_items: Sequence[UsableItem]) -> list[str]:
    leads = [
        item["name"]
        for item in usable_items
        if _category(item) not in _NEVER_LEAD_SNACK_CATEGORIES
    ]
    return leads or [item["name"] for item in usable_items]


def _category(item: UsableItem) -> str:
    return str(item["food"].get("category") or "").strip().casefold()


def _title_words(title: str) -> frozenset[str]:
    words = (_singular(word) for word in _TITLE_WORD.findall(title.casefold()))
    return frozenset(word for word in words if word not in _TITLE_LINKING_WORDS)


def _singular(word: str) -> str:
    if len(word) > 3 and word.endswith("s") and not word.endswith("ss"):
        return word[:-1]
    return word


def _same_dish(first: frozenset[str], second: frozenset[str]) -> bool:
    combined = first | second
    if not combined:
        return True
    return len(first & second) / len(combined) >= _SAME_DISH_WORD_OVERLAP
