"""Structured recipe models exchanged with the generation provider."""

from __future__ import annotations

import math
from collections.abc import Mapping, Sequence
from typing import Annotated, Any

from pydantic import (
    AfterValidator,
    BaseModel,
    BeforeValidator,
    ConfigDict,
    Field,
    create_model,
    field_validator,
    model_validator,
)


def _blank_to_none(value: str | None) -> str | None:
    if value is None:
        return None
    return value.strip() or None


def _whole_minutes(value: Any) -> Any:
    """Round a time to whole minutes, and read a time of zero or less as None.

    Provider output is validated one batch at a time, so a single "0 minutes"
    for a plating step would otherwise reject every recipe in the batch.
    Non-numbers pass through for Pydantic to reject.
    """
    if isinstance(value, bool) or not isinstance(value, int | float):
        return value
    if not math.isfinite(value):
        return value
    minutes = round(value)
    return minutes if minutes > 0 else None


_OptionalText = Annotated[str | None, AfterValidator(_blank_to_none)]
_OptionalMinutes = Annotated[int | None, BeforeValidator(_whole_minutes)]


class RecipeIngredient(BaseModel):
    """One recipe ingredient and its optional tracked-inventory mapping.

    Attributes:
        name: The ingredient as the cook calls it, such as "Garlic".
        inventory_item_id: The food the ingredient draws on. None for a
            kitchen basic, which is always on hand and never deducted.
        use_amount: The amount in ``unit``, which the cook flow converts into
            the food's stock unit for deduction. None only in recipes that
            the quality check rejects.
        unit: The unit of ``use_amount``, one of the food's convertible units.
        prep: How the ingredient is prepared, such as "minced" or "peeled and
            cut into 1/4-inch dice". None when it needs no preparation, and
            in string-step recipes.
        display_amount: The amount as a cook says it, without the ingredient
            name, such as "3 cloves" or "1 cup (200 g)". None in string-step
            recipes, and the app then formats ``use_amount``.
    """

    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1)
    inventory_item_id: str | None = None
    use_amount: float | None = None
    unit: str = Field(min_length=1)
    prep: _OptionalText = None
    display_amount: _OptionalText = None

    @field_validator("name", "unit")
    @classmethod
    def reject_blank_text(cls, value: str) -> str:
        """Keep structured ingredient labels useful to the UI and checks."""
        if not value.strip():
            raise ValueError("Ingredient text must not be blank")
        return value.strip()

    @field_validator("use_amount")
    @classmethod
    def require_finite_amount(cls, value: float | None) -> float | None:
        """Prevent NaN and infinity from crossing the provider seam."""
        if value is not None and not math.isfinite(value):
            raise ValueError("Ingredient amount must be finite")
        return value


class RecipeStep(BaseModel):
    """One stage of a recipe's method.

    Steps are flat. ``phase`` labels the component a step works on without
    grouping steps, so a recipe whose components interleave keeps its true
    cooking order.

    Attributes:
        phase: The meal component the stage works on, such as "Rice" or
            "Finish". None for a dish with one component, and in string-step
            recipes.
        instruction: What to do, as a short action heading, a newline, then
            one to three sentences. In a string-step recipe, the whole step
            text.
        doneness_cue: A sentence on what the cook sees, smells or tests to
            know the stage is done, such as "Ready when the edges are set but
            the center still wobbles." None when the stage has no endpoint,
            such as plating.
        minutes: About how long the stage takes, in whole minutes. None when
            the stage is untimed.
        why: A few words on why the stage matters, when the reason changes
            the result. None otherwise.
        uses: The ``inventory_item_id`` of each recipe ingredient the stage
            uses, in the order it uses them. Empty for stages that add no
            ingredient, and in string-step recipes.
    """

    model_config = ConfigDict(extra="forbid")

    phase: _OptionalText = None
    instruction: str = Field(min_length=1)
    doneness_cue: _OptionalText = None
    minutes: _OptionalMinutes = None
    why: _OptionalText = None
    uses: list[str] = Field(default_factory=list)

    @model_validator(mode="before")
    @classmethod
    def read_string_step(cls, data: Any) -> Any:
        """Read a string-step recipe's plain text step as its instruction."""
        return {"instruction": data} if isinstance(data, str) else data

    @field_validator("instruction")
    @classmethod
    def reject_blank_instruction(cls, value: str) -> str:
        """Require every step to contain usable instructions."""
        if not value.strip():
            raise ValueError("Recipe steps must not be blank")
        return value.strip()


class Recipe(BaseModel):
    """A generated recipe before it receives a persistent recipe identity.

    A string-step recipe stores each step as plain text and has no headnote,
    times, equipment, prep or spoken amounts. It still validates: each string
    becomes a step holding only its instruction, and the other fields are
    empty.

    Attributes:
        title: The dish's name.
        headnote: One or two sentences on what the dish is and why it works.
            None in string-step recipes.
        cook_time_minutes: Minutes from start to plate. A generated recipe
            omits it, and validation copies ``total_minutes`` into it.
        servings: How many people the recipe feeds.
        active_minutes: Hands-on minutes. None in string-step recipes.
        total_minutes: Minutes from start to plate, including rests,
            preheating and resting rice. None in string-step recipes.
        equipment: The pans, tools and appliances the method needs.
        ingredients: The ingredients in the order the method first uses them.
        steps: The method, one stage per step.
    """

    model_config = ConfigDict(extra="forbid")

    title: str = Field(min_length=1)
    headnote: _OptionalText = None
    cook_time_minutes: int = Field(gt=0)
    servings: int = Field(gt=0)
    active_minutes: _OptionalMinutes = None
    total_minutes: _OptionalMinutes = None
    equipment: list[str] = Field(default_factory=list)
    ingredients: list[RecipeIngredient] = Field(min_length=1)
    steps: list[RecipeStep] = Field(min_length=1)

    @model_validator(mode="before")
    @classmethod
    def copy_total_into_cook_time(cls, data: Any) -> Any:
        """Fill ``cook_time_minutes`` from ``total_minutes`` when it is missing.

        A generated recipe states only ``total_minutes``.
        """
        if isinstance(data, Mapping) and data.get("cook_time_minutes") is None:
            total = _whole_minutes(data.get("total_minutes"))
            if total is not None:
                return {**data, "cook_time_minutes": total}
        return data

    @field_validator("title")
    @classmethod
    def reject_blank_title(cls, value: str) -> str:
        """Require a visible recipe title."""
        if not value.strip():
            raise ValueError("Recipe title must not be blank")
        return value.strip()

    @field_validator("equipment")
    @classmethod
    def drop_blank_equipment(cls, value: list[str]) -> list[str]:
        """Keep only named pieces of equipment."""
        return [item.strip() for item in value if item.strip()]


class RecipeGenerationResponse(BaseModel):
    """The provider response requested by the recipe generation node."""

    model_config = ConfigDict(extra="forbid")

    recipes: list[Recipe] = Field(default_factory=list)


def recipe_batch_model(
    batch_ceiling: int,
    units_by_food: Mapping[str, Sequence[str]],
    *,
    has_basics: bool = False,
) -> type[RecipeGenerationResponse]:
    """Return a response model whose JSON schema fits this kitchen.

    Gemini enforces the schema while it decodes. ``maxItems`` stops the batch
    at the ceiling instead of writing recipes the caller would discard, and
    an ingredient's unit must be one of the kitchen's units, or a spoon or
    cup measure when the kitchen has basics. Pydantic enforces
    neither rule, and the schema does not list the food ids, so
    ``generate_recipes`` trims an oversized batch and ``check_quality``
    rejects unknown foods. There is deliberately no minimum: an empty list is
    the honest answer for a kitchen that cannot make a meal.

    Args:
        batch_ceiling: The most recipes the model may return.
        units_by_food: Each usable food's id and the units it may be used in.
            Must not be empty, because an ingredient must name a food.
        has_basics: Whether the prompt lists kitchen basics, which recipes
            measure in pinches, spoons, cups or ml.

    Raises:
        ValueError: When ``units_by_food`` is empty.
    """
    if not units_by_food:
        raise ValueError("A recipe batch schema needs at least one food")
    return create_model(
        f"RecipeBatchOf{batch_ceiling}",
        __base__=RecipeGenerationResponse,
        recipes=(
            list[Recipe],
            Field(
                default_factory=list,
                json_schema_extra={
                    "items": _recipe_schema(
                        units_by_food, _BASIC_UNITS if has_basics else ()
                    ),
                    "maxItems": batch_ceiling,
                },
            ),
        ),
    )


# The largest unit enum a live Gemini call accepted next to the rest of the
# recipe schema. A longer list is sent as a plain string instead.
_MAX_UNIT_ENUM_VALUES = 30
# The units a recipe may measure a kitchen basic in, such as "1 tsp salt".
# Basics are never converted or deducted, so these only need to read well.
_BASIC_UNITS = ("pinch", "tsp", "tbsp", "cup", "ml")


def _object(properties: dict[str, Any], *optional: str) -> dict[str, Any]:
    return {
        "type": "object",
        "properties": properties,
        "required": [name for name in properties if name not in optional],
    }


def _recipe_schema(
    units_by_food: Mapping[str, Sequence[str]], basic_units: Sequence[str]
) -> dict[str, Any]:
    """Return the JSON schema of one generated recipe.

    Every field is required except a step's ``minutes``, because the model
    fills a required field more reliably than an optional one. The schema
    holds one ingredient shape whatever the number of foods. Gemini answers
    ``400 INVALID_ARGUMENT`` when the schema lists the food ids, whether as
    one enum or as an ``anyOf`` with a variant for each food, so
    ``inventory_item_id`` is a plain string holding the food's prompt label
    from ``FoodLabels``, and ``check_quality`` rejects an ingredient whose
    label names no food. A kitchen basic's ingredient holds the basic's
    label the same way. ``unit`` is limited to the units of all the foods
    together, plus ``basic_units``. A unit that belongs to a different food
    is left to the cook flow, which asks for the amount. A step's ``uses`` is a list of
    plain strings for the same reason as the id, and ``check_quality`` keeps
    only the foods the recipe lists. Text that may be absent,
    such as ``prep``, ``why`` and a step's ``phase``, is a plain string the
    model leaves empty, and validation reads it as None. ``steps`` has no
    ``maxItems``, because the dish decides how many steps it needs.
    ``cook_time_minutes`` is left out, because validation copies it from
    ``total_minutes``.
    """
    text = {"type": "string"}
    positive_whole = {"type": "integer", "minimum": 1}
    kitchen_units = list(
        dict.fromkeys(
            [
                *(unit for food_units in units_by_food.values() for unit in food_units),
                *basic_units,
            ]
        )
    )
    unit = (
        {**text, "enum": kitchen_units}
        if 0 < len(kitchen_units) <= _MAX_UNIT_ENUM_VALUES
        else text
    )
    ingredient = _object(
        {
            "name": text,
            "inventory_item_id": text,
            "use_amount": {"type": "number"},
            "unit": unit,
            "display_amount": text,
            "prep": text,
        }
    )
    step = _object(
        {
            "phase": text,
            "instruction": text,
            "doneness_cue": text,
            "minutes": {"type": "integer"},
            "why": text,
            "uses": {"type": "array", "items": text},
        },
        "minutes",
    )
    return _object(
        {
            "title": text,
            "headnote": text,
            "servings": positive_whole,
            "active_minutes": positive_whole,
            "total_minutes": positive_whole,
            "equipment": {"type": "array", "items": text},
            "ingredients": {
                "type": "array",
                "minItems": 1,
                "items": ingredient,
            },
            "steps": {"type": "array", "minItems": 1, "items": step},
        }
    )
