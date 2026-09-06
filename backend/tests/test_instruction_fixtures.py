"""Schema checks for curated, provider-free instruction evaluation cases."""

import json
from pathlib import Path


def test_instruction_fixtures_are_complete_and_have_both_expected_outcomes() -> None:
    path = Path(__file__).parents[1] / "app/ai/eval/instruction_fixtures.json"
    fixtures = json.loads(path.read_text(encoding="utf-8"))

    assert len(fixtures) == 4
    expected_by_name = {
        "vague instructions": "reject",
        "missing heat and timing": "reject",
        "unsupported ingredient": "reject",
        "complete brief pasta": "accept",
    }
    assert {fixture["name"]: fixture["expected"] for fixture in fixtures} == expected_by_name
    for fixture in fixtures:
        assert set(fixture) == {"name", "instruction", "expected", "reason"}
        assert fixture["instruction"].strip()
        assert fixture["reason"].strip()
