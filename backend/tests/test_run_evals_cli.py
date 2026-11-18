import json
import os
import subprocess
import sys
from pathlib import Path

from app.ai.eval.cases import load_cases

BACKEND = Path(__file__).parents[1]


def run_cli(*args: str) -> subprocess.CompletedProcess[str]:
    env = {
        key: value
        for key, value in os.environ.items()
        if not key.startswith(("GEMINI_", "LANGSMITH_", "LANGCHAIN_"))
    }
    return subprocess.run(
        [sys.executable, "-m", "scripts.run_evals", *args],
        cwd=BACKEND,
        env={**env, "PYTHONPATH": str(BACKEND)},
        check=True,
        capture_output=True,
        text=True,
    )


def test_documented_offline_command_scores_the_whole_dataset_for_free():
    scorecard = json.loads(run_cli("--json").stdout)

    assert scorecard["mode"] == "offline"
    assert scorecard["cases"] == len(load_cases())
    assert scorecard["cases_with_recipes"] == scorecard["cases"]
    assert scorecard["usage"] == []


def test_default_output_is_a_readable_scorecard():
    text = run_cli().stdout

    assert text.startswith("FreshPlate recipe eval (offline)")
    assert "Preference alignment    100.0" in text
