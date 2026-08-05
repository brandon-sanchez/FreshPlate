"""Recipe graph nodes and their deterministic seams."""

from __future__ import annotations

import json
import math
import re
from collections.abc import Iterable, Mapping, Sequence
from datetime import date, datetime
from typing import Any, Literal, Protocol

from pydantic import ValidationError

from app.ai.agents.limits import DEFAULT_BATCH_CEILING, MAX_BATCH_CEILING
from app.ai.agents.models import Recipe, RecipeGenerationResponse, RecipeIngredient
from app.ai.agents.state import (
    GenerationResult,
    InventoryAnalysis,
    QualityResult,
    RetrievalResult,
    UsableItem,
)
from app.ai.llm.retry import PipelineDeadline
from app.ai.prompts.loader import PromptTemplate, load_prompt
from app.ai.rag.vector_store import (
    DEFAULT_MATCH_LIMIT,
    DEFAULT_MATCH_THRESHOLD,
    RetrievedRecipe,
)

EXPIRING_WITHIN_DAYS = 5
MAX_QUALITY_RETRIES = 1
QUALITY_RETRY_MIN_BUDGET_SECONDS = 20.0
GENERATION_DOCS_CEILING = 5
_QUERY_TERM_SEPARATOR = re.compile(r"[^\w]+", flags=re.UNICODE)


class RecipeProviderPort(Protocol):
    """The structured-generation seam required by the recipe graph."""

    async def generate(
        self,
        prompt: str,
        *,
        response_model: type[RecipeGenerationResponse],
        system_instruction: str | None,
        deadline: PipelineDeadline | None,
    ) -> RecipeGenerationResponse: ...


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
    """Filter inventory and produce priority-ordered retrieval inputs.

    Expired, depleted, and zero-quantity rows never reach the generator. Rows
    expiring today through five days from ``today`` are placed first and carry
    an explicit ``is_expiring`` flag for downstream prompt and UI work.
    """
    reference_date = today or date.today()
    raw_inventory = state.get("inventory", [])
    if not isinstance(raw_inventory, Sequence) or isinstance(
        raw_inventory, (str, bytes)
    ):
        raise ValueError("Recipe state inventory must be a sequence")

    candidates: list[tuple[tuple[int, int, int], UsableItem, str]] = []
    for index, raw_item in enumerate(raw_inventory):
        if not isinstance(raw_item, Mapping):
            raise ValueError("Recipe state inventory items must be mappings")

        item_id = _required_text(raw_item, "id")
        name = _required_text(raw_item, "name")
        quantity = _quantity(raw_item.get("quantity", 1))
        if quantity <= 0 or _is_depleted(raw_item.get("depleted_at")):
            continue

        expiration_date = _expiration_date(raw_item.get("expiration_date"))
        if expiration_date is not None and expiration_date < reference_date:
            continue

        days_until_expiration = (
            (expiration_date - reference_date).days
            if expiration_date is not None
            else None
        )
        is_expiring = days_until_expiration is not None and (
            0 <= days_until_expiration <= EXPIRING_WITHIN_DAYS
        )
        unit = _unit(raw_item.get("unit", "item"))
        usable_item: UsableItem = {
            "id": item_id,
            "name": name,
            "quantity": quantity,
            "unit": unit,
            "expiration_date": expiration_date,
            "days_until_expiration": days_until_expiration,
            "is_expiring": is_expiring,
        }
        normalized_name = normalize_query_term(name)
        if not normalized_name:
            raise ValueError(f"Inventory item '{item_id}' has no searchable name")

        priority = 0 if is_expiring else 1
        days_priority = (
            days_until_expiration
            if days_until_expiration is not None and is_expiring
            else 0
        )
        candidates.append(
            ((priority, days_priority, index), usable_item, normalized_name)
        )

    candidates.sort(key=lambda candidate: candidate[0])
    usable_items = [candidate[1] for candidate in candidates]
    query_terms = _unique_terms(candidate[2] for candidate in candidates)
    return {"usable_items": usable_items, "query_terms": query_terms}


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
    query_terms = _unique_terms(
        normalize_query_term(term) for term in raw_terms
    )
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
    provider: RecipeProviderPort,
    *,
    prompt: PromptTemplate | None = None,
    deadline: PipelineDeadline | None = None,
) -> GenerationResult:
    """Generate grounded recipes and enforce the inventory amount contract."""
    template = prompt or load_prompt("generate_recipes")
    batch_ceiling = _batch_ceiling(state)
    usable_items = _usable_items(state.get("usable_items", []))
    active_deadline = deadline or _state_deadline(state)
    response = await provider.generate(
        _generation_prompt(state, usable_items),
        response_model=RecipeGenerationResponse,
        system_instruction=template.system,
        deadline=active_deadline,
    )
    validated_response = RecipeGenerationResponse.model_validate(response)
    inventory_by_id = {item["id"]: item for item in usable_items}
    recipes = [
        _cap_recipe_amounts(
            _untrack_unit_mismatches(recipe, inventory_by_id),
            inventory_by_id,
        )
        for recipe in validated_response.recipes
    ]
    retry_count = _retry_count(state)
    if state.get("quality_feedback"):
        # The router bounds retries against the caller's configured limit,
        # so the counter must stay truthful: capping it here would let a
        # limit above the default retry forever.
        retry_count = retry_count + 1
    return {
        "generated_recipes": recipes[:batch_ceiling],
        "retry_count": retry_count,
    }


def check_quality(state: Mapping[str, Any]) -> QualityResult:
    """Keep only complete recipes grounded in the analyzed inventory."""
    usable_items = _usable_items(state.get("usable_items", []))
    inventory_by_id = {item["id"]: item for item in usable_items}
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

        issues = _quality_issues(recipe, inventory_by_id)
        if issues:
            failures.append(f"Recipe '{recipe.title}': {'; '.join(issues)}")
        else:
            valid_recipes.append(recipe)

    if not generated:
        failures.append("No recipes were generated.")

    return {
        "valid_recipes": valid_recipes,
        "quality_feedback": "\n".join(failures) if failures else None,
    }


def route_after_quality(
    state: Mapping[str, Any],
    *,
    quality_retry_limit: int = MAX_QUALITY_RETRIES,
    retry_only_when_no_valid: bool = False,
) -> Literal["retry", "finish"]:
    """Route quality failures while respecting the caller's retry budget."""
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


def _required_text(item: Mapping[str, Any], field: str) -> str:
    value = item.get(field)
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"Inventory item '{field}' must be a non-empty string")
    return value


def _quantity(value: Any) -> float:
    try:
        quantity = float(value)
    except (TypeError, ValueError) as exc:
        raise ValueError("Inventory quantity must be numeric") from exc
    if not math.isfinite(quantity):
        raise ValueError("Inventory quantity must be finite")
    return quantity


def _unit(value: Any) -> str:
    if not isinstance(value, str) or not value.strip():
        return "item"
    return value.strip()


def _expiration_date(value: Any) -> date | None:
    if value is None or value == "":
        return None
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    if isinstance(value, str):
        try:
            return date.fromisoformat(value.strip())
        except ValueError as exc:
            raise ValueError("Inventory expiration_date must be ISO formatted") from exc
    raise ValueError("Inventory expiration_date must be a date or ISO string")


def _is_depleted(value: Any) -> bool:
    return value is not None and value != ""


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
    if not isinstance(raw_items, Sequence) or isinstance(raw_items, (str, bytes)):
        raise ValueError("Recipe state usable_items must be a sequence")
    items: list[UsableItem] = []
    for raw_item in raw_items:
        if not isinstance(raw_item, Mapping):
            raise ValueError("Recipe state usable_items must contain mappings")
        item_id = _required_text(raw_item, "id")
        name = _required_text(raw_item, "name")
        unit = _required_text(raw_item, "unit")
        quantity = raw_item.get("quantity")
        parsed_quantity = _quantity(quantity)
        if parsed_quantity <= 0:
            raise ValueError("Usable inventory quantities must be greater than zero")
        items.append(
            {
                "id": item_id,
                "name": name,
                "quantity": parsed_quantity,
                "unit": unit,
                "expiration_date": _expiration_date(raw_item.get("expiration_date")),
                "days_until_expiration": _optional_int(
                    raw_item.get("days_until_expiration")
                ),
                "is_expiring": bool(raw_item.get("is_expiring", False)),
            }
        )
    return items


def _generation_prompt(
    state: Mapping[str, Any],
    usable_items: Sequence[UsableItem],
) -> str:
    """Build the grounded user prompt for the versioned system instruction."""
    lines = [
        (
            "Create up to the requested number of recipe suggestions from the "
            "usable inventory."
        ),
        (
            "Retrieved recipes are inspiration, not templates. Do not copy them "
            "as templates."
        ),
        (
            "Respect available amounts softly: scale servings or choose another "
            "dish instead of assuming more inventory."
        ),
        (
            "For tracked ingredients, use the supplied inventory_item_id and "
            "express use_amount in that item's own unit."
        ),
        (
            "Untracked staples may use a null inventory_item_id. Return only the "
            "structured response requested by the caller."
        ),
        (
            "Use the full batch ceiling when distinct grounded recipes are "
            "possible. Return fewer only when no additional grounded recipe "
            "can be made from this inventory."
        ),
        "",
        "Usable inventory:",
    ]
    for item in usable_items:
        urgency = "; expiring soon" if item["is_expiring"] else ""
        lines.append(
            f"- {item['id']}: {item['name']} - {item['quantity']} {item['unit']}"
            f"{urgency}"
        )

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

    lines.extend(("", f"Batch ceiling: {_batch_ceiling(state)}"))
    feedback = state.get("quality_feedback")
    if feedback:
        lines.extend(("", "Quality feedback from the previous attempt:", str(feedback)))
    return "\n".join(lines)


def _untrack_unit_mismatches(
    recipe: Recipe,
    inventory_by_id: Mapping[str, UsableItem],
) -> Recipe:
    """Demote unit-mismatched inventory links to untracked staples.

    Barcode-sourced inventory often carries packaging units such as
    "Container (14 servings)" that no sensible recipe cooks in, so the
    model legitimately writes kitchen units instead. A mismatched link
    would make the cook-flow deduction meaningless, but it does not make
    the recipe wrong - so only the link is dropped. Grounding is then
    judged on the ingredients whose units match the inventory.
    """
    ingredients: list[RecipeIngredient] = []
    changed = False
    for ingredient in recipe.ingredients:
        item_id = ingredient.inventory_item_id
        item = inventory_by_id.get(item_id) if item_id is not None else None
        if item is not None and ingredient.unit.casefold() != item["unit"].casefold():
            ingredients.append(
                ingredient.model_copy(update={"inventory_item_id": None})
            )
            changed = True
        else:
            ingredients.append(ingredient)
    if not changed:
        return recipe
    return recipe.model_copy(update={"ingredients": ingredients})


def _cap_recipe_amounts(
    recipe: Recipe,
    inventory_by_id: Mapping[str, UsableItem],
) -> Recipe:
    ingredients: list[RecipeIngredient] = []
    for ingredient in recipe.ingredients:
        item_id = ingredient.inventory_item_id
        item = inventory_by_id.get(item_id) if item_id is not None else None
        if item is None or ingredient.use_amount is None:
            ingredients.append(ingredient)
            continue
        ingredients.append(
            ingredient.model_copy(
                update={
                    "use_amount": min(ingredient.use_amount, item["quantity"]),
                }
            )
        )
    return recipe.model_copy(update={"ingredients": ingredients})


def _quality_issues(
    recipe: Recipe,
    inventory_by_id: Mapping[str, UsableItem],
) -> list[str]:
    issues: list[str] = []
    grounded = False
    for ingredient in recipe.ingredients:
        if ingredient.use_amount is None:
            issues.append(f"ingredient '{ingredient.name}' is missing use_amount")
        elif not math.isfinite(ingredient.use_amount) or ingredient.use_amount <= 0:
            issues.append(f"ingredient '{ingredient.name}' has an invalid use_amount")

        item_id = ingredient.inventory_item_id
        if item_id is None:
            continue
        item = inventory_by_id.get(item_id)
        if item is None:
            issues.append(
                f"ingredient '{ingredient.name}' references missing inventory "
                f"id '{item_id}'"
            )
            continue
        grounded = True
        if (
            ingredient.use_amount is not None
            and math.isfinite(ingredient.use_amount)
            and ingredient.use_amount > item["quantity"]
        ):
            issues.append(
                f"ingredient '{ingredient.name}' uses more than the available "
                f"{item['quantity']}"
            )
    if not grounded:
        issues.append("recipe has no grounded inventory ingredients")
    return issues


def _batch_ceiling(state: Mapping[str, Any]) -> int:
    value = state.get("batch_ceiling", DEFAULT_BATCH_CEILING)
    if (
        not isinstance(value, int)
        or isinstance(value, bool)
        or value < 0
        or value > MAX_BATCH_CEILING
    ):
        raise ValueError(
            "Recipe batch_ceiling must be an integer between 0 and "
            f"{MAX_BATCH_CEILING}"
        )
    return value


def _retry_count(state: Mapping[str, Any]) -> int:
    value = state.get("retry_count", 0)
    if not isinstance(value, int) or isinstance(value, bool) or value < 0:
        raise ValueError("Recipe retry_count must be a non-negative integer")
    return value


def _optional_int(value: Any) -> int | None:
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValueError("Inventory days_until_expiration must be an integer")
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
