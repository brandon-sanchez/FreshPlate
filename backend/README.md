# Run the FreshPlate API

From `backend/`, create a Python environment and install the dependencies:

```sh
python3 -m venv venv
venv/bin/pip install -r requirements.txt
venv/bin/pip install ruff==0.16.1
cp .env.example .env
```

Fill in the Supabase URL, publishable key, secret key, and Gemini API key in `.env`.
Keep `SUPABASE_SECRET_KEY` in the backend environment. Never put it in the mobile app or an `EXPO_PUBLIC_` variable.
The backend also accepts `SUPABASE_SERVICE_ROLE_KEY` for projects using legacy keys.

From the repository root, apply the migrations to your linked Supabase project:

```sh
supabase db push --linked
```

From `backend/`, start the API:

```sh
venv/bin/uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload --reload-dir app
```

Open `/health` to check the server. Recipe requests also need a valid Supabase user session and household inventory.

## Reset the demo household

Create a dedicated demo user and household in Supabase, then set their UUIDs explicitly. An administrator must insert the household into `demo_households`; ordinary authenticated users cannot modify this registry. The account must own the household; the reset refuses mismatched or arbitrary household IDs.

```sh
export DEMO_HOUSEHOLD_ID='household-uuid'
export DEMO_USER_ID='user-uuid'
export DEMO_DATABASE_URL='postgresql://...'
python -m app.scripts.seed_demo
```

Run this command from `backend/` using an explicit service role database connection in `DEMO_DATABASE_URL` (the URI is passed to libpq unchanged). It atomically replaces the dedicated household's 20 curated items, with expiry dates calculated relative to the day of each reset. Apply the demo migration before running it. Demo credentials stay in your local environment and are never committed.

## Deploy the feed changes

Apply `20260905063603_secure_atomic_recipe_feed_refills.sql` before deploying this backend revision.
This migration moves feed writes to service-only database functions. Authenticated users retain read access to their own sessions.

Mount `SUPABASE_SECRET_KEY` from your secret manager in the backend runtime, alongside the existing Supabase and Gemini settings.
For Cloud Run, bind the `supabase-secret-key` secret to `SUPABASE_SECRET_KEY` when deploying.
Grant the runtime service account permission to read that secret.

After deployment, create a recipe session and request its next page using an authenticated test account.
A missing backend key causes these requests to return `RECIPE_FEED_UNAVAILABLE`.
