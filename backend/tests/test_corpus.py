"""Behavior tests for the Food.com corpus transformation seam."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from app.ai.rag.corpus import (
    DATASET_RECIPE_FILE,
    DATASET_SLUG,
    CorpusRecipe,
    parse_recipe_row,
    read_recipe_rows,
    source_fingerprint,
    stratified_subset,
)


def test_parse_recipe_row_builds_one_searchable_chunk_per_recipe() -> None:
    recipe = parse_recipe_row(
        {
            "RecipeId": 42,
            "Name": "Coriander Pasta",
            "RecipeCategory": "Pasta",
            "Keywords": ["quick", "vegetarian"],
            "Description": "A bright weeknight pasta.",
            "RecipeIngredientParts": ["pasta", "coriander leaves"],
            "RecipeInstructions": ["Boil the pasta.", "Toss with herbs."],
        }
    )

    assert recipe == CorpusRecipe(
        id=42,
        title="Coriander Pasta",
        category="Pasta",
        content=(
            "Title: Coriander Pasta\n"
            "Category: Pasta\n"
            "Keywords: quick; vegetarian\n"
            "Description: A bright weeknight pasta.\n"
            "Ingredients: pasta; coriander leaves\n"
            "Instructions: Boil the pasta. Toss with herbs."
        ),
    )


@pytest.mark.parametrize(
    "row",
    [
        {"RecipeId": None, "Name": "Missing id"},
        {"RecipeId": 7, "Name": "   "},
        {"RecipeId": -1, "Name": "Invalid id"},
    ],
)
def test_parse_recipe_row_skips_invalid_source_rows(row: dict[str, Any]) -> None:
    assert parse_recipe_row(row) is None


def test_stratified_subset_is_stable_and_preserves_category_proportions() -> None:
    recipes = [
        CorpusRecipe(
            id=recipe_id,
            title=f"Recipe {recipe_id}",
            category="Small" if recipe_id < 3 else "Large",
            content=f"Title: Recipe {recipe_id}",
        )
        for recipe_id in range(1, 11)
    ]

    first = stratified_subset(recipes, target_size=5)
    second = stratified_subset(reversed(recipes), target_size=5)

    assert first == second
    assert len(first) == 5
    assert sum(recipe.category == "Small" for recipe in first) == 1
    assert sum(recipe.category == "Large" for recipe in first) == 4


def test_stratified_subset_deduplicates_ids_and_returns_all_when_under_target() -> None:
    recipes = [
        CorpusRecipe(1, "A", "Title: A", "Breakfast"),
        CorpusRecipe(1, "A duplicate", "Title: A duplicate", "Breakfast"),
        CorpusRecipe(2, "B", "Title: B", "Dinner"),
    ]

    selected = stratified_subset(recipes, target_size=10)

    assert [recipe.id for recipe in selected] == [1, 2]


def test_source_fingerprint_changes_when_selected_recipe_content_changes() -> None:
    recipes = [CorpusRecipe(1, "A", "Title: A", "Breakfast")]

    original = source_fingerprint(recipes)
    changed = source_fingerprint([CorpusRecipe(1, "A", "Title: changed", "Breakfast")])

    assert original != changed


def test_corpus_constants_lock_the_download_contract() -> None:
    assert DATASET_SLUG == "irkaal/foodcom-recipes-and-reviews"
    assert DATASET_RECIPE_FILE == "recipes.parquet"


def test_read_recipe_rows_reports_missing_optional_dependency(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    import importlib

    source = tmp_path / "recipes.parquet"
    source.write_bytes(b"not parquet")

    def missing_pyarrow(name: str) -> Any:
        if name == "pyarrow.parquet":
            raise ModuleNotFoundError("No module named 'pyarrow'")

    monkeypatch.setattr(importlib, "import_module", missing_pyarrow)

    with pytest.raises(RuntimeError, match="pyarrow"):
        next(read_recipe_rows(source))


def test_read_recipe_rows_yields_bounded_parquet_batches(tmp_path: Path) -> None:
    import pyarrow as pa
    import pyarrow.parquet as parquet

    source = tmp_path / "recipes.parquet"
    parquet.write_table(
        pa.table(
            {
                "RecipeId": [1, 2],
                "Name": ["One", "Two"],
                "RecipeCategory": ["Breakfast", "Dinner"],
            }
        ),
        source,
    )

    rows = list(read_recipe_rows(source, batch_size=1))

    assert rows == [
        {"RecipeId": 1, "Name": "One", "RecipeCategory": "Breakfast"},
        {"RecipeId": 2, "Name": "Two", "RecipeCategory": "Dinner"},
    ]
