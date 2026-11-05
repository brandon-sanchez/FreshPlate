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
evaluator traces to LangSmith.

Current offline evidence: `cases=22`, `succeeded_cases=20`, `failed_cases=2`,
`coverage=100.0`, `completeness=100.0`, `preference=100.0`, and
`quantity_violation_rate=0.0`. The two failures are intentional deterministic
semantic rejections. No live experiment links or traces have been produced;
issue 34 follow-up evidence remains pending.

The judge uses one rubric for preference alignment and gross or implausible
quantity violations. Offline mode reports synthetic judge scores, uses
deterministic fixtures, and does not contact Gemini, LangSmith, or a database.
