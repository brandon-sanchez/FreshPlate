# FreshPlate evaluation

FreshPlate evaluates the recipe pipeline with 22 curated inventory cases in
`backend/app/ai/eval/dataset.json`. The local runner prints coverage,
completeness, preference alignment, and quantity violation rate.

Run the credential-free fixture:

```sh
cd backend
python -m scripts.run_evals --mode offline
```

Use `--mode live` only with `GEMINI_API_KEY`, `LANGSMITH_API_KEY`, and the
Supabase retrieval configuration available. The live runner calls Gemini,
reads the production Supabase vector store, and uploads the experiment and
evaluator traces to LangSmith. The LangSmith client reads its key from the
process environment, so export `backend/.env` first:

```sh
cd backend
set -a && source .env && set +a
python -m scripts.run_evals --mode live --experiment freshplate-mvp-eval
```

## Offline scorecard

`cases=22`, `succeeded_cases=20`, `failed_cases=2`, `coverage=100.0`,
`completeness=100.0`, `preference=100.0`, and `quantity_violation_rate=0.0`.
The two failures are intentional deterministic semantic rejections. Offline
preference scores are synthetic, so they prove the scoring path rather than
recipe quality.

## Live experiment: 2026-11-02

Experiment `freshplate-mvp-eval-5f67a3a2` ran all 22 cases on
`gemini-3.6-flash` with the production retriever.
[Experiment comparison view](https://smith.langchain.com/o/7206356c-f487-40f9-a39e-9799d92f5072/datasets/cc55e808-91ae-46b2-8066-69a179975d4d/compare?selectedSessions=cecc2ff9-fcd1-438a-9a11-eb55bb971e0f).

| Metric | Value |
| --- | --- |
| Cases | 22 |
| Succeeded | 8 |
| Failed | 14 |
| Coverage | 100.0 |
| Completeness | 100.0 |
| Preference alignment | 92.5 |
| Quantity violation rate | 0.0 |

Scores average the 8 succeeded cases. Failures break down as:

- 12 cases ended with `Gemini pipeline deadline exhausted` in `check_quality`.
  Recipe generation took 15 to 19 seconds, and the provider refuses to start
  a Gemini call with less than 10 seconds left of the 25 second pipeline
  budget, so the quality check never ran.
- 2 cases (`lemon rice`, `apple salad`) returned no valid recipe after the
  quality check rejected every candidate.

The judge separates on-request recipes from off-request ones. `bean chili`
produced Bean-Stuffed Baked Peppers and scored 40, with the rationale that it
is not a traditional bean chili while every quantity stayed within inventory.
The other seven succeeded cases scored 100.

Traces for the succeeded cases:

- [bean tacos](https://smith.langchain.com/o/7206356c-f487-40f9-a39e-9799d92f5072/projects/p/cecc2ff9-fcd1-438a-9a11-eb55bb971e0f/r/01a1a05a-4aa1-7dd0-b39d-1c9547d34528)
- [mushroom toast](https://smith.langchain.com/o/7206356c-f487-40f9-a39e-9799d92f5072/projects/p/cecc2ff9-fcd1-438a-9a11-eb55bb971e0f/r/01a1a05b-6e97-75e2-bffc-77c03cc19898)
- [pesto gnocchi](https://smith.langchain.com/o/7206356c-f487-40f9-a39e-9799d92f5072/projects/p/cecc2ff9-fcd1-438a-9a11-eb55bb971e0f/r/01a1a05c-75d3-7c88-a33b-f4f29bae786d)
- [bean chili](https://smith.langchain.com/o/7206356c-f487-40f9-a39e-9799d92f5072/projects/p/cecc2ff9-fcd1-438a-9a11-eb55bb971e0f/r/01a1a05c-c55a-7c08-85c5-3de75bffb42a)
- [potato hash](https://smith.langchain.com/o/7206356c-f487-40f9-a39e-9799d92f5072/projects/p/cecc2ff9-fcd1-438a-9a11-eb55bb971e0f/r/01a1a05d-9c7a-7481-9d97-cb52d1d5077a)
- [peanut noodles](https://smith.langchain.com/o/7206356c-f487-40f9-a39e-9799d92f5072/projects/p/cecc2ff9-fcd1-438a-9a11-eb55bb971e0f/r/01a1a05e-356b-77ae-b896-c6d04a9f49d1)
- [zucchini bake](https://smith.langchain.com/o/7206356c-f487-40f9-a39e-9799d92f5072/projects/p/cecc2ff9-fcd1-438a-9a11-eb55bb971e0f/r/01a1a05e-cec4-7826-9b99-b710219d8ada)
- [carrot soup](https://smith.langchain.com/o/7206356c-f487-40f9-a39e-9799d92f5072/projects/p/cecc2ff9-fcd1-438a-9a11-eb55bb971e0f/r/01a1a05f-5b9b-76ae-9d7f-9eee436dca67)

## Judge

The judge uses one rubric for preference alignment and gross or implausible
quantity violations. Offline mode uses deterministic fixtures and does not
contact Gemini, LangSmith, or a database.
