import json
import re
from pathlib import Path

import pytest

from app.ai.eval.cases import PREFERENCE_KEYS, EvalCaseError, load_cases

REPO = Path(__file__).parents[2]


def test_dataset_holds_22_kitchens_each_asking_for_something():
    cases = load_cases()

    assert len(cases) == 22
    assert len({case.name for case in cases}) == 22
    assert all(case.preferences.get("meal") for case in cases)
    assert all(case.inventory for case in cases)


def test_preference_keys_match_the_ones_the_app_sends():
    source = (REPO / "mobile/types/recipes.ts").read_text()
    declared = source.split("RECIPE_PREFERENCE_KEYS = [", 1)[1].split("]", 1)[0]

    assert set(re.findall(r'"(\w+)"', declared)) == PREFERENCE_KEYS


def test_loading_rejects_a_duplicate_case_name(tmp_path):
    case = {
        "name": "toast",
        "preferences": {"meal": "Breakfast"},
        "inventory": [
            {
                "id": "bread",
                "name": "bread",
                "available": 2,
                "stock_base": "each",
                "each_label": "slice",
            }
        ],
    }
    path = tmp_path / "cases.json"
    path.write_text(json.dumps([case, case]))

    with pytest.raises(EvalCaseError, match="toast"):
        load_cases(path)


def test_loading_rejects_an_unknown_preference_key(tmp_path):
    path = tmp_path / "cases.json"
    path.write_text(
        json.dumps(
            [
                {
                    "name": "toast",
                    "preferences": {"request": "toast"},
                    "inventory": [
                        {
                            "id": "bread",
                            "name": "bread",
                            "available": 2,
                            "stock_base": "each",
                            "each_label": "slice",
                        }
                    ],
                }
            ]
        )
    )

    with pytest.raises(EvalCaseError, match="request"):
        load_cases(path)


def test_loading_rejects_an_empty_dataset(tmp_path):
    path = tmp_path / "cases.json"
    path.write_text("[]")

    with pytest.raises(EvalCaseError):
        load_cases(path)
