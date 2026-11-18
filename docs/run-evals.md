# Run the evals

This guide runs the recipe evals from your machine. For what each metric means and the latest results, see the [evaluation reference](evals.md).

## Run the offline evals

The offline evals need no API keys. Use them to check the scoring code after you change it.

1. Set up the backend environment as described in [`backend/README.md`](../backend/README.md).
2. From `backend/`, run the offline mode:

	```sh
	venv/bin/python -m scripts.run_evals
	```

The runner prints a scorecard. A healthy offline run returns a recipe for all 22 cases and scores 100 on every metric. Add `--json` to print it as JSON.

## Run the live evals

The live evals call Gemini and read the production Supabase vector store. Each run makes real, billed Gemini calls for all 22 cases.

1. In `backend/.env`, set `GEMINI_API_KEY`, `SUPABASE_URL`, and `SUPABASE_PUBLISHABLE_KEY`.
2. From `backend/`, run the live mode:

	```sh
	venv/bin/python -m scripts.run_evals --live
	```

The runner prints the scorecard, including the Gemini calls and tokens the run used.
