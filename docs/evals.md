# FreshPlate evaluation

FreshPlate evaluates the recipe pipeline with 22 curated inventory cases in
`backend/app/ai/eval/dataset.json`. The local runner prints coverage,
completeness, preference alignment, and quantity violation rate.

Run the credential-free fixture:

```sh
cd backend
python -m scripts.run_evals --mode offline
```

Use `--mode live` only when `GEMINI_API_KEY` is set. A live run can send the
named experiment to LangSmith when `LANGSMITH_API_KEY` is also set. This
repository does not claim trace or experiment links until a real run creates
them. Record those links and the printed scorecard here after that run.

The judge uses one rubric for preference alignment and gross or implausible
quantity violations. Offline mode reports synthetic judge scores, uses deterministic fixtures, and does not
contact Gemini, LangSmith, or a database.
