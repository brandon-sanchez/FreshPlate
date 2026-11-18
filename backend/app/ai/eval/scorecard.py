"""Aggregate eval results into the scorecard the runner prints."""

from __future__ import annotations

import statistics
from collections.abc import Iterable, Sequence

from pydantic import BaseModel, ConfigDict

from app.ai.eval.runner import CaseResult
from app.ai.eval.usage import ModelUsage


class CaseRow(BaseModel):
    """One case's scores, averaged over its recipes.

    The scorecard prints one row per case, and LangSmith gets the same
    numbers as the case's feedback. A mean is None when no recipe was
    scored for it.

    Attributes:
        name: The case's name.
        recipes: How many recipes the pipeline returned.
        coverage, completeness, mapping_validity: Mean code scores.
        preference_alignment: Mean alignment of the case's judged recipes.
        unmet_preferences: Every preference key a recipe missed, once each.
        quantity_violations: Every violation the judge listed, in order.
        judge_failures: Recipes the judge couldn't grade.
        seconds: Pipeline wall time, to a tenth of a second.
        error: Why the pipeline returned nothing, or None.
    """

    model_config = ConfigDict(extra="forbid")

    name: str
    recipes: int
    coverage: float | None
    completeness: float | None
    mapping_validity: float | None
    preference_alignment: float | None
    unmet_preferences: list[str]
    quantity_violations: list[str]
    judge_failures: int
    seconds: float
    error: str | None


class Scorecard(BaseModel):
    """Headline metrics for one eval run.

    Recipe metrics average every recipe the pipeline returned, across all
    cases, so each card a cook could see counts once. A metric is None when
    no recipe was scored.

    Attributes:
        mode: "offline" or "live".
        experiment: The LangSmith experiment's name, or None when the run
            wasn't uploaded.
        url: The LangSmith experiment's link, or None.
        cases: How many cases ran.
        cases_with_recipes: Cases that returned at least one recipe.
        cases_failed: Cases whose pipeline failed, such as on its deadline.
        recipes: Recipes returned across all cases.
        coverage: Mean ingredient coverage, 0 to 100.
        completeness: Mean structural completeness, 0 to 100.
        mapping_validity: Mean mapping validity, 0 to 100.
        preference_alignment: Mean share of stated preferences met, 0 to 100,
            over the recipes the judge graded.
        quantity_violation_rate: Share of graded recipes with at least one
            quantity violation, 0 to 1.
        judge_failures: Recipes the judge failed to grade.
        median_seconds: Median pipeline wall time per case.
        max_seconds: Slowest pipeline wall time.
        usage: Gemini calls and tokens, one row per response model.
        case_rows: One row per case, in dataset order.
    """

    model_config = ConfigDict(extra="forbid")

    mode: str
    experiment: str | None
    url: str | None
    cases: int
    cases_with_recipes: int
    cases_failed: int
    recipes: int
    coverage: float | None
    completeness: float | None
    mapping_validity: float | None
    preference_alignment: float | None
    quantity_violation_rate: float | None
    judge_failures: int
    median_seconds: float
    max_seconds: float
    usage: list[ModelUsage]
    case_rows: list[CaseRow]

    @classmethod
    def from_results(
        cls,
        results: Sequence[CaseResult],
        *,
        mode: str,
        usage: Sequence[ModelUsage] = (),
        experiment: str | None = None,
        url: str | None = None,
    ) -> Scorecard:
        """Return the scorecard for ``results``, which must not be empty."""
        scores = [score for result in results for score in result.scores]
        graded = [score for score in scores if score.judge_error is None]
        seconds = [result.output.seconds for result in results]
        return cls(
            mode=mode,
            experiment=experiment,
            url=url,
            cases=len(results),
            cases_with_recipes=sum(bool(result.scores) for result in results),
            cases_failed=sum(result.output.error is not None for result in results),
            recipes=len(scores),
            coverage=_mean(score.coverage for score in scores),
            completeness=_mean(score.completeness for score in scores),
            mapping_validity=_mean(score.mapping_validity for score in scores),
            preference_alignment=_mean(
                score.preference_alignment
                for score in graded
                if score.preference_alignment is not None
            ),
            quantity_violation_rate=_rate(
                bool(score.quantity_violations) for score in graded
            ),
            judge_failures=len(scores) - len(graded),
            median_seconds=round(statistics.median(seconds), 1),
            max_seconds=round(max(seconds), 1),
            usage=list(usage),
            case_rows=[case_row(result) for result in results],
        )

    def render(self) -> str:
        """Return the scorecard as plain text for a terminal."""
        lines = [
            f"FreshPlate recipe eval ({self.mode})",
            f"Experiment: {self.experiment or 'not uploaded'}",
        ]
        if self.url:
            lines.append(f"Link: {self.url}")
        lines += [
            "",
            f"Cases with recipes      {self.cases_with_recipes}/{self.cases}",
            f"Cases failed            {self.cases_failed}",
            f"Recipes scored          {self.recipes}",
            f"Coverage                {_percent(self.coverage)}",
            f"Completeness            {_percent(self.completeness)}",
            f"Mapping validity        {_percent(self.mapping_validity)}",
            f"Preference alignment    {_percent(self.preference_alignment)}",
            f"Quantity violation rate {_ratio(self.quantity_violation_rate)}",
            f"Judge failures          {self.judge_failures}",
            f"Pipeline seconds        median {self.median_seconds}, "
            f"max {self.max_seconds}",
            "",
            f"{'Case':<18}{'Recipes':>8}{'Pref':>7}{'Qty':>5}{'Sec':>7}  Notes",
        ]
        lines += [_render_row(row) for row in self.case_rows]
        lines += ["", "Gemini usage"]
        if not self.usage:
            lines.append("  none")
        lines += [
            f"  {row.response_model}: {row.calls} calls ({row.failed_calls} failed), "
            f"{row.prompt_tokens} input, {row.output_tokens} output, "
            f"{row.thinking_tokens} thinking tokens"
            for row in self.usage
        ]
        return "\n".join(lines)


def case_row(result: CaseResult) -> CaseRow:
    """Return one case's scores, averaged over its recipes."""
    scores = result.scores
    graded = [score for score in scores if score.judge_error is None]
    return CaseRow(
        name=result.name,
        recipes=len(scores),
        coverage=_mean(score.coverage for score in scores),
        completeness=_mean(score.completeness for score in scores),
        mapping_validity=_mean(score.mapping_validity for score in scores),
        preference_alignment=_mean(
            score.preference_alignment
            for score in graded
            if score.preference_alignment is not None
        ),
        unmet_preferences=list(
            dict.fromkeys(key for score in graded for key in score.unmet_preferences)
        ),
        quantity_violations=[
            violation for score in graded for violation in score.quantity_violations
        ],
        judge_failures=len(scores) - len(graded),
        seconds=round(result.output.seconds, 1),
        error=result.output.error,
    )


def _render_row(row: CaseRow) -> str:
    notes = row.error or (
        f"missed {', '.join(row.unmet_preferences)}" if row.unmet_preferences else ""
    )
    alignment = (
        "-" if row.preference_alignment is None else f"{row.preference_alignment:.0f}"
    )
    return (
        f"{row.name:<18}{row.recipes:>8}{alignment:>7}"
        f"{len(row.quantity_violations):>5}{row.seconds:>7.1f}  {notes}"
    ).rstrip()


def _mean(values: Iterable[int | float]) -> float | None:
    collected = list(values)
    return round(statistics.fmean(collected), 1) if collected else None


def _rate(flags: Iterable[bool]) -> float | None:
    collected = list(flags)
    return round(sum(collected) / len(collected), 3) if collected else None


def _percent(value: float | None) -> str:
    return "-" if value is None else f"{value:.1f}"


def _ratio(value: float | None) -> str:
    return "-" if value is None else f"{value:.3f}"
