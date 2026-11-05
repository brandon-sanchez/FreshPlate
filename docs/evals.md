# Evaluation reference

FreshPlate evaluates the recipe pipeline against a fixed set of kitchens. This page lists the dataset, the metrics, the judge, and the latest scorecards. To run the evals yourself, see [Run the evals](run-evals.md).

## Dataset

`backend/app/ai/eval/dataset.json` holds 22 cases. Each case has:

| Field | Meaning |
| --- | --- |
| `name` | The requested dish, such as `tomato pasta`. The runner sends it as the preference `request`. |
| `inventory` | The kitchen for the case. Each item has `id`, `name`, `quantity`, and `unit`. |
| `expected_coverage` | The lowest and highest acceptable ingredient coverage, as percentages. `backend/tests/test_eval_scorers.py` checks the fixture recipes against it. |

## Metrics

The runner scores each recipe that the pipeline returns. Scorecard values average the cases that succeeded.

| Metric | Source | Definition |
| --- | --- | --- |
| `coverage` | `ingredient_coverage_percent` in `backend/app/ai/eval/scorers.py` | Percentage of a recipe's ingredients that map to an inventory item. The app shows the same number as the match percentage on each card. |
| `completeness` | `completeness_percent` in `scorers.py` | Percentage of four structural checks that pass: a title, at least one ingredient, a name and unit on every ingredient, and non-empty steps. |
| `preference` | The judge's `preference_alignment` | How well the recipe matches the requested dish, from 0 to 100. |
| `quantity_violation_rate` | The judge's `quantity_violations` | Share of succeeded cases with at least one gross or implausible quantity, from 0 to 1. |
| `succeeded_cases` | Runner | Cases that returned at least one valid recipe. |
| `failed_cases` | Runner | Cases that returned no valid recipe or raised an error. |

## Judge

`backend/app/ai/eval/judge.py` is one LLM judge with one rubric. It returns a `JudgeResult` with three fields:

- `preference_alignment`, an integer from 0 to 100, scored against the requested dish and the inventory.
- `quantity_violations`, a list of quantities that exceed the inventory, are zero or negative, or are implausible for the unit.
- `rationale`, a short explanation.

The judge gives no credit for ingredients that are missing from the inventory, including common pantry staples. Offline mode replaces the judge with a fixed result of 100 and no violations.

## Modes

| Mode | Model | Retriever | Network | Output |
| --- | --- | --- | --- | --- |
| `offline` | `FakeProvider` with fixture recipes | Fixture retriever | None | Scorecard on stdout |
| `live` | `gemini-3.6-flash` | Production Supabase vector store | Gemini, Supabase, and LangSmith | Scorecard on stdout and a LangSmith experiment |

Offline mode tests the scoring code, not recipe quality. CI runs the offline mode through `backend/tests/test_eval_judge_runner.py`. It never runs the live mode.

## Offline scorecard

The runner prints this scorecard on `main`:

```json
{
  "cases": 22,
  "completeness": 100.0,
  "coverage": 100.0,
  "experiment": "freshplate-eval-local",
  "failed_cases": 2,
  "judge_mode": "synthetic",
  "preference": 100.0,
  "quantity_violation_rate": 0.0,
  "succeeded_cases": 20
}
```

The two failed cases are fixtures that the quality check rejects on purpose.

## Live scorecard, 2026-11-02

Experiment `freshplate-mvp-eval-5f67a3a2` ran all 22 cases on `gemini-3.6-flash` with the production retriever. The experiment and its traces are in a private LangSmith project.

| Metric | Value |
| --- | --- |
| Cases | 22 |
| Succeeded | 8 |
| Failed | 14 |
| Coverage | 100.0 |
| Completeness | 100.0 |
| Preference alignment | 92.5 |
| Quantity violation rate | 0.0 |

The scores average the 8 succeeded cases. The 14 failures have two causes:

- 12 cases stopped with `Gemini pipeline deadline exhausted` in `check_quality`. Generation took 15 to 19 seconds of the 25-second pipeline budget. `GeminiProvider` does not start a call with less than 10 seconds left, so the judge in `check_quality` never ran.
- 2 cases, `lemon rice` and `apple salad`, returned no valid recipe because the quality check rejected every candidate.

For `bean chili`, the pipeline returned Bean-Stuffed Baked Peppers. The judge scored it 40 because it is not a bean chili, although every quantity stayed within the inventory. The other seven succeeded cases scored 100.

`POST /api/recipes/suggestions` uses the same graph and the same 25-second budget, so it hits the same deadline failure. [PR #73](https://github.com/brandon-sanchez/FreshPlate/pull/73) targets it.
