"""Behavior tests for prompt loading and trace metadata."""

from __future__ import annotations

from pathlib import Path

import pytest

from app.ai.prompts.loader import PromptLoadError, load_prompt
from app.ai.prompts.tracing import build_trace_config


def test_load_prompt_reads_the_versioned_generate_recipes_prompt() -> None:
    prompt = load_prompt("generate_recipes")

    assert prompt.name == "generate_recipes"
    assert prompt.version == 8
    assert prompt.model == "gemini-3.6-flash"
    assert prompt.thinking == "minimal"
    assert "inventory" in prompt.system.lower()


def test_generate_prompt_requires_portions_and_observable_instruction_cues() -> None:
    system = load_prompt("generate_recipes").system.lower()

    assert "realistic servings" in system
    assert "observable cue" in system
    assert "165°f" in system
    assert "145°f" in system
    assert "at least three" not in system
    assert "additional cues, not substitutes" in system
    assert "action heading" in system


def test_generate_prompt_teaches_cookbook_structure_without_step_numbers() -> None:
    system = load_prompt("generate_recipes").system

    for field in (
        "headnote",
        "active_minutes",
        "total_minutes",
        "equipment",
        "display_amount",
        "prep",
        "phase",
        "doneness_cue",
        "why",
        "uses",
    ):
        assert field in system
    assert "order of first use" in system.lower()
    assert "Step 1" not in system
    assert not any(
        line.strip().lower().startswith("step ") for line in system.splitlines()
    )


def test_generate_prompt_splits_steps_at_checkpoints_with_no_fixed_count() -> None:
    system = load_prompt("generate_recipes").system.lower()

    assert "ends at something they can check or hand off" in system
    assert "split any step that would need two doneness cues" in system
    assert "let each dish decide its own count" in system
    assert "never merge stages to keep a recipe short" in system
    assert "too crammed" in system


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
        "prompt_version": 8,
        "request_id": "request-123",
    }


def test_trace_config_rejects_an_empty_request_id() -> None:
    prompt = load_prompt("generate_recipes")

    with pytest.raises(ValueError, match="request_id"):
        build_trace_config(prompt, request_id=" ")


def test_meal_judge_prompt_is_a_minimal_thinking_checklist() -> None:
    prompt = load_prompt("assess_meals")

    assert prompt.version == 3
    assert prompt.thinking == "minimal"
    assert "reasoning fields before the yes/no fields" in prompt.system
    assert "Water is always available" in prompt.system


def test_generate_prompt_allows_a_snack_or_dessert_only_when_asked() -> None:
    system = load_prompt("generate_recipes").system.lower()

    assert "a real snack or a real dessert only when the cook asks for one" in system
    assert "a meal has a main component" in system
    assert "a mix of two vegetables is not a meal" in system
    assert "celery with peanut butter" in system
    assert "never pass off a side dish, a snack, or a dessert as a meal" in system


def test_meal_judge_asks_whether_people_would_eat_it_on_its_own() -> None:
    system = load_prompt("assess_meals").system.lower()

    assert "would most people eat this on its own as the requested_dish" in system
    assert "a garnish plate" in system
    assert "is not a meal" in system


def test_generator_and_judge_share_one_definition_of_a_meal() -> None:
    meal = (
        "a main component, either a protein such as meat, fish, eggs, tofu, "
        "beans, or cheese, or a substantial dish such as pasta, a stew, a soup "
        "with body, or a grain or rice bowl, and enough food for a full plate "
        "per serving"
    )
    snack = (
        "celery with peanut butter, apple slices with cheese, or hummus with "
        "crackers"
    )

    dessert = (
        "a fruit crumble, rice pudding, or yogurt with berries and honey"
    )

    for name in ("generate_recipes", "assess_meals"):
        system = load_prompt(name).system
        assert meal in system, name
        assert snack in system, name
        assert dessert in system, name
