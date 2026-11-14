"""Recipe graph nodes and their deterministic seams."""

from __future__ import annotations

import json
import re
from collections.abc import Iterable, Mapping, Sequence
from datetime import date
from decimal import Decimal
from typing import Any, Literal, Protocol

from pydantic import TypeAdapter, ValidationError

from app.ai.agents.limits import DEFAULT_BATCH_CEILING, MAX_BATCH_CEILING
from app.ai.agents.models import (
    Recipe,
    RecipeGenerationResponse,
    recipe_batch_model,
)
from app.ai.agents.state import (
    GenerationResult,
    InventoryAnalysis,
    QualityResult,
    RetrievalResult,
    UsableItem,
)
from app.ai.llm.protocol import LLMProvider
from app.ai.llm.retry import PipelineDeadline
from app.ai.prompts.loader import PromptTemplate, load_prompt
from app.ai.rag.vector_store import (
    DEFAULT_MATCH_LIMIT,
    DEFAULT_MATCH_THRESHOLD,
    RetrievedRecipe,
)
from app.inventory.food_facts import FoodLine
from app.inventory.units import Exact, FoodFacts, convertible_units, to_stock

EXPIRING_WITHIN_DAYS = 5
MAX_QUALITY_RETRIES = 1
QUALITY_RETRY_MIN_BUDGET_SECONDS = 20.0
GENERATION_DOCS_CEILING = 5
# Embedding every pantry item name blurs the retrieval query, so only the
# highest-priority names are embedded.
RETRIEVAL_QUERY_TERM_LIMIT = 30
# Category names come from the food_categories seed in
# supabase/migrations/20260329180000_create_inventory_tables.sql.
MAIN_COMPONENT_CATEGORIES = frozenset({"meat & seafood"})
WATER = "water"
WATER_RULE = (
    "Water is always available: never list it as an ingredient, but steps may use "
    "it. Every other ingredient, including salt, pepper, oil, butter and every "
    "seasoning or fat, must come from the listed inventory."
)
_QUERY_TERM_SEPARATOR = re.compile(r"[^\w]+", flags=re.UNICODE)
_USABLE_ITEMS = TypeAdapter(list[UsableItem])


class RecipeRetrieverPort(Protocol):
    """The retrieval seam required by the graph node."""

    async def search(
        self,
        query: str,
        *,
        limit: int,
        match_threshold: float,
        deadline: PipelineDeadline | None,
    ) -> list[RetrievedRecipe]: ...


def analyze_inventory(
    state: Mapping[str, Any],
    *,
    today: date | None = None,
) -> InventoryAnalysis:
    """Turn the kitchen's foods into usable items and retrieval terms.

    ``state["inventory"]`` holds one ``FoodLine`` mapping per food. Foods with
    no unexpired stock never reach the generator. Each usable item lists the
    units the converter can turn into a number for that food. Foods expiring
    today through five days from ``today`` are placed first and carry an
    explicit ``is_expiring`` flag for downstream prompt and UI work. The
    retrieval query lists expiring foods, then main components, then the rest,
    capped at ``RETRIEVAL_QUERY_TERM_LIMIT`` names.

    Raises:
        ValueError: When the inventory is not a sequence or a line is not a
            valid ``FoodLine``.
    """
    reference_date = today or date.today()
    raw_inventory = state.get("inventory", [])
    if not isinstance(raw_inventory, Sequence) or isinstance(
        raw_inventory, (str, bytes)
    ):
        raise ValueError("Recipe state inventory must be a sequence")

    candidates: list[tuple[tuple[int, int, int], UsableItem]] = []
    query_candidates: list[tuple[tuple[int, int, int], str]] = []
    for index, raw_food in enumerate(raw_inventory):
        try:
            food = FoodLine.model_validate(raw_food)
        except ValidationError as exc:
            raise ValueError(f"Invalid recipe inventory line: {exc}") from exc
        if food.available <= 0:
            continue

        days_until_expiration = (
            (food.next_expiry - reference_date).days
            if food.next_expiry is not None
            else None
        )
        is_expiring = days_until_expiration is not None and (
            0 <= days_until_expiration <= EXPIRING_WITHIN_DAYS
        )
        usable_item: UsableItem = {
            "id": food.id,
            "name": food.name,
            "quantity": food.available,
            "unit": food.stock_unit,
            "units": list(convertible_units(food.facts)),
            "lot_count": food.lot_count,
            "expiration_date": food.next_expiry,
            "days_until_expiration": days_until_expiration,
            "is_expiring": is_expiring,
            "food": food.model_dump(mode="json"),
        }

        priority = 0 if is_expiring else 1
        days_priority = (
            days_until_expiration
            if days_until_expiration is not None and is_expiring
            else 0
        )
        candidates.append(((priority, days_priority, index), usable_item))
        if is_expiring:
            query_priority = 0
        elif _is_main_component(food.category):
            query_priority = 1
        else:
            query_priority = 2
        query_candidates.append(
            ((query_priority, days_priority, index), normalize_query_term(food.name))
        )

    candidates.sort(key=lambda candidate: candidate[0])
    query_candidates.sort(key=lambda candidate: candidate[0])
    usable_items = [candidate[1] for candidate in candidates]
    query_terms = _unique_terms(candidate[1] for candidate in query_candidates)
    return {
        "usable_items": usable_items,
        "query_terms": query_terms[:RETRIEVAL_QUERY_TERM_LIMIT],
    }


async def retrieve_recipes(
    state: Mapping[str, Any],
    retriever: RecipeRetrieverPort,
    *,
    limit: int = DEFAULT_MATCH_LIMIT,
    match_threshold: float = DEFAULT_MATCH_THRESHOLD,
    deadline: PipelineDeadline | None = None,
) -> RetrievalResult:
    """Embed the analyzed query and return the highest-ranked recipe matches."""
    raw_terms = state.get("query_terms", [])
    if not isinstance(raw_terms, Sequence) or isinstance(raw_terms, (str, bytes)):
        raise ValueError("Recipe state query_terms must be a sequence")

    if any(not isinstance(term, str) for term in raw_terms):
        raise ValueError("Recipe state query_terms must contain strings")
    query_terms = _unique_terms(normalize_query_term(term) for term in raw_terms)
    if not query_terms:
        return {"retrieved_recipes": []}

    recipes = await retriever.search(
        " ".join(query_terms),
        limit=limit,
        match_threshold=match_threshold,
        deadline=deadline,
    )
    return {"retrieved_recipes": recipes}


async def generate_recipes(
    state: Mapping[str, Any],
    provider: LLMProvider,
    *,
    prompt: PromptTemplate | None = None,
    deadline: PipelineDeadline | None = None,
) -> GenerationResult:
    """Generate recipes while preserving provider amounts for validation.

    The response schema limits each ingredient to one usable food and that
    food's units. A kitchen with no usable food makes no provider call and
    returns an empty batch.
    """
    template = prompt or load_prompt("generate_recipes")
    batch_ceiling = _batch_ceiling(state)
    usable_items = _usable_items(state.get("usable_items", []))
    retry_count = _retry_count(state)
    if state.get("quality_feedback"):
        # The router bounds retries against the caller's configured limit,
        # so the counter must stay truthful: capping it here would let a
        # limit above the default retry forever.
        retry_count = retry_count + 1
    if not usable_items:
        return {"generated_recipes": [], "retry_count": retry_count}
    active_deadline = deadline or _state_deadline(state)
    response = await provider.generate(
        _generation_prompt(state, usable_items),
        response_model=recipe_batch_model(
            batch_ceiling, {item["id"]: item["units"] for item in usable_items}
        ),
        system_instruction=template.system,
        deadline=active_deadline,
        thinking=template.thinking,
    )
    validated_response = RecipeGenerationResponse.model_validate(response)
    return {
        "generated_recipes": validated_response.recipes[:batch_ceiling],
        "retry_count": retry_count,
    }


def check_quality(state: Mapping[str, Any]) -> QualityResult:
    """Keep only complete recipes grounded in the analyzed inventory.

    An empty batch is how the generator reports a kitchen that cannot
    make a meal, so it produces no quality feedback and never triggers a retry.
    """
    usable_items = _usable_items(state.get("usable_items", []))
    inventory_by_id = {item["id"]: item for item in usable_items}
    facts_by_id = {
        item["id"]: FoodLine.model_validate(item["food"]).facts for item in usable_items
    }
    generated = state.get("generated_recipes", [])
    if not isinstance(generated, Sequence) or isinstance(generated, (str, bytes)):
        raise ValueError("Recipe state generated_recipes must be a sequence")

    valid_recipes: list[Recipe] = []
    failures: list[str] = []
    for index, raw_recipe in enumerate(generated, start=1):
        try:
            recipe = Recipe.model_validate(raw_recipe)
        except (TypeError, ValidationError) as exc:
            failures.append(f"Recipe {index} is incomplete: {_validation_message(exc)}")
            continue

        issues = _quality_issues(recipe, inventory_by_id, facts_by_id)
        if issues:
            failures.append(f"Recipe '{recipe.title}': {'; '.join(issues)}")
        else:
            valid_recipes.append(recipe)

    return {
        "valid_recipes": valid_recipes,
        "quality_feedback": "\n".join(failures) if failures else None,
    }


def is_water(name: str) -> bool:
    """Return whether an ingredient is water, the one ingredient always on hand."""
    return normalize_query_term(name) == WATER


def route_after_quality(
    state: Mapping[str, Any],
    *,
    quality_retry_limit: int = MAX_QUALITY_RETRIES,
    retry_only_when_no_valid: bool = False,
) -> Literal["retry", "finish"]:
    """Retry only when generated recipes were rejected, within the retry budget."""
    if retry_only_when_no_valid and state.get("valid_recipes"):
        return "finish"
    if state.get("quality_feedback") and _retry_count(state) < quality_retry_limit:
        deadline = _state_deadline(state)
        if (
            deadline is not None
            and deadline.remaining_seconds < QUALITY_RETRY_MIN_BUDGET_SECONDS
        ):
            return "finish"
        return "retry"
    return "finish"


def normalize_query_term(value: str) -> str:
    """Case-fold and whitespace-normalize one inventory name for retrieval."""
    if not isinstance(value, str):
        raise ValueError("Recipe query terms must be strings")
    return " ".join(_QUERY_TERM_SEPARATOR.sub(" ", value.casefold()).split())


def _is_main_component(category: str | None) -> bool:
    return (
        isinstance(category, str)
        and category.strip().casefold() in MAIN_COMPONENT_CATEGORIES
    )


def _unique_terms(terms: Iterable[str]) -> list[str]:
    unique: list[str] = []
    seen: set[str] = set()
    for term in terms:
        if term and term not in seen:
            seen.add(term)
            unique.append(term)
    return unique


def _state_deadline(state: Mapping[str, Any]) -> PipelineDeadline | None:
    deadline = state.get("deadline")
    if deadline is None:
        return None
    if not isinstance(deadline, PipelineDeadline):
        raise ValueError("Recipe state deadline must be a PipelineDeadline")
    return deadline


def _usable_items(raw_items: Any) -> list[UsableItem]:
    try:
        return _USABLE_ITEMS.validate_python(raw_items)
    except ValidationError as exc:
        raise ValueError(f"Recipe state usable_items are invalid: {exc}") from exc


def _generation_prompt(
    state: Mapping[str, Any],
    usable_items: Sequence[UsableItem],
) -> str:
    """Build the grounded user prompt for the versioned system instruction."""
    ceiling = _batch_ceiling(state)
    lines = [
        (
            f"Suggest up to {ceiling} distinct meals this kitchen can make. Each "
            "recipe is a separate option the cook chooses between, so every recipe "
            "may use the full listed inventory, including the same main ingredient "
            "as another recipe. Make each one a different dish that varies in "
            "cooking method or format, not a variation of another. If the kitchen "
            f"cannot make a real meal, return an empty list. {WATER_RULE}"
        ),
        "",
        (
            "Create up to the requested number of recipe suggestions from the "
            "usable inventory."
        ),
        (
            "Retrieved recipes are inspiration, not templates. Do not copy them "
            "as templates."
        ),
        (
            "Use only the listed inventory, within the listed amounts. Never "
            "add untracked staples, shopping-list ingredients, or hidden "
            "garnishes."
        ),
        (
            "Every ingredient must map to one listed inventory_item_id. Write "
            "its use_amount in whichever of that food's listed units a cook "
            "would use, such as cloves of garlic or tablespoons of oil."
        ),
        (
            "Use the full batch ceiling when distinct grounded recipes are "
            "possible. Return fewer only when no additional grounded recipe "
            "can be made from this inventory."
        ),
        "",
        "Usable inventory:",
    ]
    lines.extend(_inventory_line(item) for item in usable_items)

    lines.extend(("", "Retrieved recipe inspiration:"))
    retrieved_recipes = state.get("retrieved_recipes", [])
    rendered_retrieval = False
    if isinstance(retrieved_recipes, Sequence) and not isinstance(
        retrieved_recipes, (str, bytes)
    ):
        for recipe in retrieved_recipes[:GENERATION_DOCS_CEILING]:
            if isinstance(recipe, RetrievedRecipe):
                title = recipe.title
                content = recipe.content
                similarity = recipe.similarity
            elif isinstance(recipe, Mapping):
                title = recipe.get("title", "Untitled")
                content = recipe.get("content", "")
                similarity = recipe.get("similarity", "unknown")
            else:
                continue
            lines.append(f"- {title} ({similarity}): {content}")
            rendered_retrieval = True
    if not rendered_retrieval:
        lines.append("- None")

    preferences = state.get("preferences", {})
    lines.extend(("", "Session preferences:"))
    lines.append(_json_value(preferences))

    exclude_titles = state.get("exclude_titles", [])
    if isinstance(exclude_titles, Sequence) and not isinstance(
        exclude_titles, (str, bytes)
    ):
        lines.extend(("", "Do not repeat these shown titles:"))
        lines.append(", ".join(str(title) for title in exclude_titles) or "None")

    lines.extend(("", f"Maximum number of recipes: {ceiling}"))
    feedback = state.get("quality_feedback")
    if feedback:
        lines.extend(("", "Quality feedback from the previous attempt:", str(feedback)))
    return "\n".join(lines)


def _inventory_line(item: UsableItem) -> str:
    parts = [
        f"- {item['id']}: {item['name']}",
        f"{_amount_text(item['quantity'])} {item['unit']}",
    ]
    if item["lot_count"] > 1:
        parts.append(f"{item['lot_count']} batches")
    if item["expiration_date"] is not None:
        urgency = ", expiring soon" if item["is_expiring"] else ""
        parts.append(f"next expires {item['expiration_date'].isoformat()}{urgency}")
    parts.append(f"units: {', '.join(item['units'])}")
    return " | ".join(parts)


def _quality_issues(
    recipe: Recipe,
    inventory_by_id: Mapping[str, UsableItem],
    facts_by_id: Mapping[str, FoodFacts],
) -> list[str]:
    """Return why ``recipe`` is not grounded in the usable inventory.

    An ingredient must name a usable food, except unmapped water. A food's
    ingredients fail together only when their exact conversions add up to
    more than its available stock. ``Approximate``, ``Small`` and
    ``AskAtCook`` amounts never reject a recipe, because the cook flow
    confirms them.
    """
    issues: list[str] = []
    grounded = False
    exact_by_id: dict[str, Decimal] = {}
    for ingredient in recipe.ingredients:
        if ingredient.inventory_item_id is None and is_water(ingredient.name):
            continue
        amount = ingredient.use_amount
        if amount is None:
            issues.append(f"ingredient '{ingredient.name}' is missing use_amount")
        elif amount <= 0:
            issues.append(f"ingredient '{ingredient.name}' has an invalid use_amount")

        item_id = ingredient.inventory_item_id
        if item_id is None:
            issues.append(f"ingredient '{ingredient.name}' is not mapped to inventory")
            continue
        item = inventory_by_id.get(item_id)
        if item is None:
            issues.append(
                f"ingredient '{ingredient.name}' references missing inventory "
                f"id '{item_id}'"
            )
            continue
        grounded = True
        if amount is None or amount <= 0:
            continue
        conversion = to_stock(
            Decimal(str(amount)),
            ingredient.unit,
            facts_by_id[item_id],
        )
        if isinstance(conversion, Exact):
            exact_by_id[item_id] = (
                exact_by_id.get(item_id, Decimal(0)) + conversion.amount
            )
    for item_id, needed in exact_by_id.items():
        item = inventory_by_id[item_id]
        if needed > Decimal(str(item["quantity"])):
            issues.append(
                f"ingredients mapped to inventory item '{item_id}' need "
                f"{_amount_text(needed)} {item['unit']} in total, more than the "
                f"available {_amount_text(item['quantity'])} {item['unit']}"
            )
    if not grounded:
        issues.append("recipe has no grounded inventory ingredients")
    return issues


def _amount_text(value: float | Decimal) -> str:
    """Show an amount to at most three decimals, never in exponent form."""
    rounded = Decimal(str(value)).quantize(Decimal("0.001"))
    return f"{rounded.normalize():f}"


def _batch_ceiling(state: Mapping[str, Any]) -> int:
    value = state.get("batch_ceiling", DEFAULT_BATCH_CEILING)
    if (
        not isinstance(value, int)
        or isinstance(value, bool)
        or value < 0
        or value > MAX_BATCH_CEILING
    ):
        raise ValueError(
            f"Recipe batch_ceiling must be an integer between 0 and {MAX_BATCH_CEILING}"
        )
    return value


def _retry_count(state: Mapping[str, Any]) -> int:
    value = state.get("retry_count", 0)
    if not isinstance(value, int) or isinstance(value, bool) or value < 0:
        raise ValueError("Recipe retry_count must be a non-negative integer")
    return value


def _json_value(value: Any) -> str:
    try:
        return json.dumps(value, sort_keys=True, default=str)
    except (TypeError, ValueError):
        return str(value)


def _validation_message(error: ValidationError | TypeError) -> str:
    if isinstance(error, TypeError):
        return str(error)
    first_error = error.errors()[0]
    location = ".".join(str(part) for part in first_error.get("loc", ()))
    message = str(first_error.get("msg", "invalid value"))
    return f"{location}: {message}" if location else message
