"""Food.com corpus parsing, chunking, and deterministic subset selection."""

from __future__ import annotations

import ast
import hashlib
import importlib
import json
import math
from collections import defaultdict
from collections.abc import Iterable, Iterator, Mapping, Sequence
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

DATASET_SLUG = "irkaal/foodcom-recipes-and-reviews"
DATASET_RECIPE_FILE = "recipes.parquet"
DEFAULT_CORPUS_SIZE = 10_000
MAX_CORPUS_BATCH_SIZE = 100
PARQUET_BATCH_SIZE = 4096

_ID_FIELDS = ("RecipeId", "Id", "id")
_TITLE_FIELDS = ("Name", "title", "Title")
_CATEGORY_FIELDS = ("RecipeCategory", "category", "Category")
_KEYWORD_FIELDS = ("Keywords", "keywords")
_DESCRIPTION_FIELDS = ("Description", "description")
_INGREDIENT_FIELDS = (
    "RecipeIngredientParts",
    "Ingredients",
    "ingredients",
)
_INSTRUCTION_FIELDS = (
    "RecipeInstructions",
    "Instructions",
    "Steps",
    "steps",
)
_KNOWN_SOURCE_FIELDS = (
    *_ID_FIELDS,
    *_TITLE_FIELDS,
    *_CATEGORY_FIELDS,
    *_KEYWORD_FIELDS,
    *_DESCRIPTION_FIELDS,
    *_INGREDIENT_FIELDS,
    *_INSTRUCTION_FIELDS,
)


class CorpusParseError(RuntimeError):
    """Raised when the downloaded corpus cannot be read or shaped."""


@dataclass(frozen=True, slots=True)
class CorpusRecipe:
    """One recipe represented as exactly one searchable text chunk."""

    id: int
    title: str
    content: str
    category: str = "Uncategorized"

    def embedding_row(self, embedding: Sequence[float]) -> dict[str, Any]:
        """Return the database row shape for this recipe and its embedding."""
        return {
            "id": self.id,
            "title": self.title,
            "content": self.content,
            "embedding": list(embedding),
        }


def parse_recipe_row(row: Mapping[str, Any]) -> CorpusRecipe | None:
    """Convert a Food.com row into one recipe chunk, skipping invalid rows."""
    recipe_id = _positive_integer(_first_value(row, _ID_FIELDS))
    title = _clean_text(_first_value(row, _TITLE_FIELDS))
    if recipe_id is None or not title:
        return None

    category = _clean_text(_first_value(row, _CATEGORY_FIELDS)) or "Uncategorized"
    keywords = _clean_list(_first_value(row, _KEYWORD_FIELDS))
    ingredients = _clean_list(_first_value(row, _INGREDIENT_FIELDS))
    description = _clean_text(_first_value(row, _DESCRIPTION_FIELDS))
    instructions = _clean_list(_first_value(row, _INSTRUCTION_FIELDS))

    sections = [f"Title: {title}", f"Category: {category}"]
    if keywords:
        sections.append(f"Keywords: {'; '.join(keywords)}")
    if description:
        sections.append(f"Description: {description}")
    if ingredients:
        sections.append(f"Ingredients: {'; '.join(ingredients)}")
    if instructions:
        sections.append(f"Instructions: {' '.join(instructions)}")

    return CorpusRecipe(
        id=recipe_id,
        title=title,
        content="\n".join(sections),
        category=category,
    )


def stratified_subset(
    recipes: Iterable[CorpusRecipe],
    *,
    target_size: int = DEFAULT_CORPUS_SIZE,
) -> list[CorpusRecipe]:
    """Select a stable, approximately proportional category-stratified subset.

    The source is sorted by a stable hash within each category so selection does
    not depend on Parquet row order. A weighted round-robin then allocates rows
    in proportion to category size while ensuring every category contributes
    when the target is large enough.
    """
    if not isinstance(target_size, int) or isinstance(target_size, bool):
        raise ValueError("Corpus target size must be an integer")
    if target_size < 1:
        raise ValueError("Corpus target size must be greater than zero")

    unique: dict[int, CorpusRecipe] = {}
    for recipe in recipes:
        current = unique.get(recipe.id)
        if current is None or _recipe_sort_key(recipe) < _recipe_sort_key(current):
            unique[recipe.id] = recipe

    ordered = sorted(unique.values(), key=lambda recipe: recipe.id)
    if len(ordered) <= target_size:
        return ordered

    groups: dict[str, list[CorpusRecipe]] = defaultdict(list)
    for recipe in ordered:
        groups[recipe.category.casefold()].append(recipe)
    for group in groups.values():
        group.sort(key=_recipe_sort_key)

    group_keys = sorted(groups)
    cursors = {key: 0 for key in group_keys}
    selected_counts = {key: 0 for key in group_keys}
    selected: list[CorpusRecipe] = []

    while len(selected) < target_size:
        available = [key for key in group_keys if cursors[key] < len(groups[key])]
        key = min(
            available,
            key=lambda group_key: (
                selected_counts[group_key] / len(groups[group_key]),
                group_key,
            ),
        )
        selected.append(groups[key][cursors[key]])
        cursors[key] += 1
        selected_counts[key] += 1

    return sorted(selected, key=lambda recipe: recipe.id)


def source_fingerprint(recipes: Sequence[CorpusRecipe]) -> str:
    """Return a content fingerprint used to reject stale checkpoints."""
    payload = [asdict(recipe) for recipe in sorted(recipes, key=lambda item: item.id)]
    encoded = json.dumps(
        payload,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def read_recipe_rows(
    source_path: Path,
    *,
    batch_size: int = PARQUET_BATCH_SIZE,
) -> Iterator[Mapping[str, Any]]:
    """Yield recipe rows from the downloaded Parquet file in bounded batches."""
    if not source_path.is_file():
        raise FileNotFoundError(f"Recipe source does not exist: {source_path}")
    if (
        not isinstance(batch_size, int)
        or isinstance(batch_size, bool)
        or batch_size < 1
    ):
        raise ValueError("Parquet batch size must be a positive integer")

    try:
        parquet = importlib.import_module("pyarrow.parquet")
    except ModuleNotFoundError as exc:
        raise RuntimeError(
            "Reading recipes.parquet requires pyarrow; install backend requirements"
        ) from exc

    try:
        with parquet.ParquetFile(source_path) as parquet_file:
            available_fields = set(parquet_file.schema_arrow.names)
            columns = [
                field for field in _KNOWN_SOURCE_FIELDS if field in available_fields
            ]
            if not any(field in available_fields for field in _ID_FIELDS):
                raise CorpusParseError(
                    "recipes.parquet does not contain a RecipeId or Id column"
                )
            if not any(field in available_fields for field in _TITLE_FIELDS):
                raise CorpusParseError(
                    "recipes.parquet does not contain a Name or title column"
                )

            for batch in parquet_file.iter_batches(
                batch_size=batch_size,
                columns=columns,
            ):
                yield from batch.to_pylist()
    except CorpusParseError:
        raise
    except Exception as exc:
        raise CorpusParseError(f"Could not read recipe source {source_path}") from exc


def _first_value(row: Mapping[str, Any], names: Sequence[str]) -> Any:
    for name in names:
        if name in row:
            return row[name]

    folded = {str(key).casefold(): value for key, value in row.items()}
    for name in names:
        if name.casefold() in folded:
            return folded[name.casefold()]
    return None


def _positive_integer(value: Any) -> int | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        numeric = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(numeric) or not numeric.is_integer() or numeric <= 0:
        return None
    return int(numeric)


def _clean_text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, float) and math.isnan(value):
        return ""
    return " ".join(str(value).split())


def _clean_list(value: Any) -> list[str]:
    values = _list_value(value)
    return [cleaned for item in values if (cleaned := _clean_text(item))]


def _list_value(value: Any) -> list[Any]:
    if value is None:
        return []
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return []
        if text.startswith(("[", "(")) and text.endswith(("]", ")")):
            for parser in (json.loads, ast.literal_eval):
                try:
                    parsed = parser(text)
                except (TypeError, ValueError, SyntaxError, json.JSONDecodeError):
                    continue
                if isinstance(parsed, (list, tuple)):
                    return list(parsed)
        return [text]
    if isinstance(value, Sequence):
        return list(value)
    tolist = getattr(value, "tolist", None)
    if callable(tolist):
        converted = tolist()
        if isinstance(converted, (list, tuple)):
            return list(converted)
    return [value]


def _recipe_sort_key(recipe: CorpusRecipe) -> tuple[str, int, str]:
    stable_text = f"{recipe.id}\x00{recipe.title}\x00{recipe.content}"
    digest = hashlib.sha256(stable_text.encode("utf-8")).hexdigest()
    return digest, recipe.id, recipe.title
