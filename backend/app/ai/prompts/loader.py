"""Load the repository's versioned YAML prompts."""

from __future__ import annotations

import re
from collections.abc import Mapping
from pathlib import Path

import yaml
from pydantic import BaseModel, ConfigDict, Field, StrictInt, StrictStr, ValidationError

PROMPTS_DIR = Path(__file__).parent
_PROMPT_NAME_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]*$")
_VERSION_SUFFIX_PATTERN = re.compile(r"_v[0-9]+$")


class PromptLoadError(ValueError):
    """Raised when a named prompt cannot be found or validated."""


class PromptTemplate(BaseModel):
    """The validated fields shared by every prompt YAML file."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    name: str = Field(min_length=1)
    version: StrictInt | StrictStr
    model: str = Field(min_length=1)
    system: str = Field(min_length=1)


def load_prompt(name: str) -> PromptTemplate:
    """Load one prompt by logical name from the versioned YAML registry.

    A logical name may resolve to ``<name>.yaml`` or one versioned file named
    ``<name>_vN.yaml``. Multiple versioned files are rejected so prompt
    selection stays a deliberate code change rather than runtime configuration.
    """
    _validate_prompt_name(name)
    candidates = _prompt_candidates(name)
    if not candidates:
        raise PromptLoadError(f"Prompt '{name}' was not found")
    if len(candidates) > 1:
        paths = ", ".join(path.name for path in candidates)
        raise PromptLoadError(f"Prompt '{name}' has multiple versions: {paths}")

    path = candidates[0]
    try:
        raw_prompt = yaml.safe_load(path.read_text(encoding="utf-8"))
    except (OSError, yaml.YAMLError) as exc:
        raise PromptLoadError(f"Prompt '{name}' could not be read") from exc

    if not isinstance(raw_prompt, Mapping):
        raise PromptLoadError(f"Prompt '{name}' must contain a YAML mapping")

    try:
        prompt = PromptTemplate.model_validate(dict(raw_prompt))
    except (TypeError, ValidationError) as exc:
        raise PromptLoadError(f"Prompt '{name}' is invalid: {exc}") from exc

    logical_name = _VERSION_SUFFIX_PATTERN.sub("", name)
    if prompt.name not in {name, logical_name}:
        raise PromptLoadError(
            f"Prompt '{name}' does not match the YAML name '{prompt.name}'"
        )
    return prompt


def _prompt_candidates(name: str) -> list[Path]:
    exact = PROMPTS_DIR / f"{name}.yaml"
    versioned = sorted(
        path
        for path in PROMPTS_DIR.glob(f"{name}_v*.yaml")
        if _VERSION_SUFFIX_PATTERN.search(path.stem)
    )
    return [path for path in [exact, *versioned] if path.is_file()]


def _validate_prompt_name(name: str) -> None:
    if not isinstance(name, str) or not _PROMPT_NAME_PATTERN.fullmatch(name):
        raise PromptLoadError(
            "Prompt name must contain only letters, numbers, '_' or '-'"
        )
