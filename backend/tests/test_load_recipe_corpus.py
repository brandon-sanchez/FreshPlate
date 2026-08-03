"""Behavior tests for the corpus loader command helpers."""

from __future__ import annotations

import zipfile
from pathlib import Path
from typing import Any

import pytest

from scripts.load_recipe_corpus import (
    build_parser,
    download_dataset,
    run,
    select_recipes,
)


def test_select_recipes_reports_invalid_rows_and_returns_a_subset() -> None:
    selected, skipped = select_recipes(
        [
            {
                "RecipeId": 1,
                "Name": "Coriander Pasta",
                "RecipeCategory": "Dinner",
            },
            {"RecipeId": None, "Name": "Invalid"},
            {
                "RecipeId": 2,
                "Name": "Carrot Soup",
                "RecipeCategory": "Dinner",
            },
        ],
        target_size=1,
    )

    assert len(selected) == 1
    assert skipped == 1


def test_download_dataset_uses_kaggle_cli_and_does_not_redownload(
    tmp_path: Path,
    monkeypatch: Any,
) -> None:
    calls: list[list[str]] = []

    def fake_run(command: list[str], *, check: bool) -> None:
        calls.append(command)
        assert check
        (tmp_path / "recipes.parquet").write_bytes(b"downloaded")

    monkeypatch.setattr("scripts.load_recipe_corpus.subprocess.run", fake_run)

    first = download_dataset(tmp_path, kaggle_command="kaggle-test")
    second = download_dataset(tmp_path, kaggle_command="kaggle-test")

    assert first == second == tmp_path / "recipes.parquet"
    assert calls == [
        [
            "kaggle-test",
            "datasets",
            "download",
            "-d",
            "irkaal/foodcom-recipes-and-reviews",
            "-f",
            "recipes.parquet",
            "-p",
            str(tmp_path),
            "--unzip",
        ]
    ]


def test_download_dataset_extracts_kaggle_zip_output(
    tmp_path: Path,
    monkeypatch: Any,
) -> None:
    calls: list[list[str]] = []

    def fake_run(command: list[str], *, check: bool) -> None:
        calls.append(command)
        assert check
        with zipfile.ZipFile(tmp_path / "recipes.parquet.zip", "w") as archive:
            archive.writestr("recipes.parquet", b"downloaded")

    monkeypatch.setattr("scripts.load_recipe_corpus.subprocess.run", fake_run)

    source_path = download_dataset(tmp_path, kaggle_command="kaggle-test")

    assert source_path == tmp_path / "recipes.parquet"
    assert source_path.read_bytes() == b"downloaded"
    assert len(calls) == 1


@pytest.mark.asyncio
async def test_run_fails_for_missing_explicit_source(tmp_path: Path) -> None:
    missing_source = tmp_path / "missing.parquet"
    args = build_parser().parse_args(["--source", str(missing_source), "--dry-run"])

    with pytest.raises(FileNotFoundError, match="missing.parquet"):
        await run(args)
