"""Behavior tests for prompt loading and trace metadata."""

from __future__ import annotations

from pathlib import Path

import pytest

from app.ai.prompts.loader import PromptLoadError, load_prompt
from app.ai.prompts.tracing import build_trace_config


def test_load_prompt_reads_the_versioned_generate_recipes_prompt() -> None:
    prompt = load_prompt("generate_recipes")

    assert prompt.name == "generate_recipes"
    assert prompt.version == 3
    assert prompt.model == "gemini-3.6-flash"
    assert "inventory" in prompt.system.lower()


def test_generate_prompt_requires_portions_and_observable_instruction_cues() -> None:
    system = load_prompt("generate_recipes").system.lower()

    assert "realistic servings" in system
    assert "observable cue" in system
    assert "165°f" in system
    assert "145°f" in system
    assert "do not pad" in system


def test_load_prompt_rejects_a_prompt_without_a_version(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    (tmp_path / "broken.yaml").write_text(
        "name: broken\nmodel: gemini-3.6-flash\nsystem: test\n",
        encoding="utf-8",
    )

    from app.ai.prompts import loader

    monkeypatch.setattr(loader, "PROMPTS_DIR", tmp_path)

    with pytest.raises(PromptLoadError, match="version"):
        load_prompt("broken")


def test_load_prompt_rejects_multiple_runtime_versions(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    for version in (1, 2):
        (tmp_path / f"recipes_v{version}.yaml").write_text(
            "name: recipes\n"
            f"version: {version}\n"
            "model: gemini-3.6-flash\n"
            "system: test\n",
            encoding="utf-8",
        )

    from app.ai.prompts import loader

    monkeypatch.setattr(loader, "PROMPTS_DIR", tmp_path)

    with pytest.raises(PromptLoadError, match="multiple"):
        load_prompt("recipes")


def test_load_prompt_ignores_non_numeric_versioned_filenames(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    (tmp_path / "recipes_v1.yaml").write_text(
        "name: recipes\nversion: 1\nmodel: gemini-3.6-flash\nsystem: test\n",
        encoding="utf-8",
    )
    (tmp_path / "recipes_vdraft.yaml").write_text(
        "this is not a runtime prompt\n",
        encoding="utf-8",
    )

    from app.ai.prompts import loader

    monkeypatch.setattr(loader, "PROMPTS_DIR", tmp_path)

    prompt = load_prompt("recipes")

    assert prompt.version == 1


def test_trace_config_contains_prompt_and_request_metadata() -> None:
    prompt = load_prompt("generate_recipes")

    config = build_trace_config(prompt, request_id="request-123")

    assert set(config) == {"metadata"}
    assert config["metadata"] == {
        "prompt_name": "generate_recipes",
        "prompt_version": 3,
        "request_id": "request-123",
    }


def test_trace_config_rejects_an_empty_request_id() -> None:
    prompt = load_prompt("generate_recipes")

    with pytest.raises(ValueError, match="request_id"):
        build_trace_config(prompt, request_id=" ")
