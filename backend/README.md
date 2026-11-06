# Run the FreshPlate API

This guide sets up the FastAPI backend on your machine. For how the backend fits into the system, see [Architecture](../docs/architecture.md).

## Set up the environment

From `backend/`, create a Python 3.11 environment and install the dependencies:

```sh
python3.11 -m venv venv
venv/bin/pip install -r requirements.txt
venv/bin/pip install ruff==0.16.1
cp .env.example .env
```

In `.env`, set `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY`, and `GEMINI_API_KEY`. Projects that still use legacy Supabase keys can set `SUPABASE_SERVICE_ROLE_KEY` instead of `SUPABASE_SECRET_KEY`.

Keep `SUPABASE_SECRET_KEY` in the backend environment only. Never put it in the mobile app or in an `EXPO_PUBLIC_` variable. The backend uses it for the recipe feed functions, which only the service role can call.

To send traces to LangSmith, also set the optional `LANGSMITH_` variables in `.env`.

## Apply the migrations

From the repository root, apply the migrations to your linked Supabase project:

```sh
supabase db push --linked
```

## Load the recipe corpus

Retrieval needs the Food.com recipe embeddings in `recipe_embeddings`. The loader downloads the public Kaggle dataset, embeds the recipes with Gemini, and resumes where it stopped if you run it again. It needs the `kaggle` CLI and the keys in `.env`. From `backend/`:

```sh
venv/bin/python -m scripts.load_recipe_corpus --help
```

## Start the API

From `backend/`:

```sh
venv/bin/uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload --reload-dir app
```

Open `http://localhost:8000/health` to check that the server is up. Recipe requests also need a signed-in Supabase user with items in their household inventory.

## Reset the demo household

The demo reset replaces one dedicated household's inventory with 20 curated items. Expiry dates are relative to the day of the reset.

1. Create a dedicated demo user and household in Supabase. The user must own the household.
2. As an administrator, insert the household into `demo_households`. Ordinary users can't change this table.
3. From `backend/`, set the IDs and a service role database URL, then run the reset:

	```sh
	export DEMO_HOUSEHOLD_ID='<household-uuid>'
	export DEMO_USER_ID='<user-uuid>'
	export DEMO_DATABASE_URL='postgresql://...'
	venv/bin/python -m app.scripts.seed_demo
	```

The reset refuses a household that the user does not own or that is not in `demo_households`. Keep the demo IDs and the database URL in your local environment. Don't commit them.
