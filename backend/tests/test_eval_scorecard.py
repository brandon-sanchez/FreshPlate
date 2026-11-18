from app.ai.eval.runner import CaseResult, PipelineOutput, RecipeScore
from app.ai.eval.scorecard import Scorecard


def score(alignment, *, violations=(), unmet=(), coverage=100, judge_error=None):
    return RecipeScore(
        title="Dish",
        coverage=coverage,
        completeness=100,
        mapping_validity=100,
        preference_alignment=alignment,
        unmet_preferences=list(unmet),
        quantity_violations=list(violations),
        judge_error=judge_error,
    )


def case(name, scores, *, seconds=10.0, error=None):
    output = PipelineOutput(
        recipes=[], kitchen=[], kitchen_basics=[], seconds=seconds, error=error
    )
    return CaseResult(name=name, output=output, scores=scores)


RESULTS = [
    case("pasta", [score(100), score(50, unmet=["diet"], violations=["2 kg salt"])]),
    case(
        "curry", [score(80, coverage=50), score(None, judge_error="down")], seconds=20.0
    ),
    case("soup", [], seconds=31.0, error="TimeoutError: deadline"),
]


def test_recipe_metrics_average_every_returned_recipe():
    scorecard = Scorecard.from_results(RESULTS, mode="live")

    assert scorecard.cases == 3
    assert scorecard.cases_with_recipes == 2
    assert scorecard.cases_failed == 1
    assert scorecard.recipes == 4
    assert scorecard.coverage == 87.5
    assert scorecard.preference_alignment == 76.7
    assert scorecard.quantity_violation_rate == 0.333
    assert scorecard.judge_failures == 1
    assert scorecard.median_seconds == 20.0
    assert scorecard.max_seconds == 31.0


def test_each_case_row_names_what_went_wrong():
    rows = {
        row.name: row for row in Scorecard.from_results(RESULTS, mode="live").case_rows
    }

    assert rows["pasta"].preference_alignment == 75
    assert rows["pasta"].unmet_preferences == ["diet"]
    assert rows["pasta"].quantity_violations == 1
    assert rows["soup"].recipes == 0
    assert rows["soup"].error == "TimeoutError: deadline"


def test_rendered_scorecard_shows_headline_metrics_and_failures():
    text = Scorecard.from_results(RESULTS, mode="live").render()

    assert "Cases with recipes      2/3" in text
    assert "Preference alignment    76.7" in text
    assert "missed diet" in text
    assert "TimeoutError: deadline" in text
    assert all(line == line.rstrip() for line in text.splitlines())
