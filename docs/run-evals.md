# Run the evals

This guide runs the recipe evals from your machine. For what each metric means and the latest results, see the [evaluation reference](evals.md).

## Run the offline evals

The offline evals need no API keys. Use them to check the scoring code after you change it.

1. Set up the backend environment as described in [`backend/README.md`](../backend/README.md).
2. From `backend/`, run the offline mode:

	```sh
	venv/bin/python -m scripts.run_evals --mode offline
	```

The runner prints a JSON scorecard. On `main`, it reports 22 cases, 20 succeeded, and 2 failed. The two failures are intentional.

## Run the live evals

The live evals call Gemini, read the production Supabase vector store, and upload an experiment to LangSmith. Each run makes real, billed Gemini calls for all 22 cases.

1. In `backend/.env`, set `GEMINI_API_KEY`, `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, and `LANGSMITH_API_KEY`.
2. From `backend/`, export the file into your shell. The LangSmith client reads its key from the process environment, not from `.env`.

	```sh
	set -a && source .env && set +a
	```

3. Run the live mode with an experiment name:

	```sh
	venv/bin/python -m scripts.run_evals --mode live --experiment freshplate-mvp-eval
	```

The runner prints the scorecard and creates a LangSmith experiment named after `--experiment` with a random suffix. The first run also creates a LangSmith dataset named `<experiment>-dataset`. Later runs with the same name reuse that dataset.

If most cases fail with `Gemini pipeline deadline exhausted`, generation is using up the pipeline budget. The [evaluation reference](evals.md#live-scorecard-2026-11-02) explains this failure.
