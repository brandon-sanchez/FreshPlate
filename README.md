# FreshPlate

[![CI](https://github.com/brandon-sanchez/FreshPlate/actions/workflows/ci.yml/badge.svg)](https://github.com/brandon-sanchez/FreshPlate/actions/workflows/ci.yml)

FreshPlate tracks fridge and pantry inventory, then suggests recipes grounded in what is available. The mobile app uses Expo and React Native. The API uses FastAPI, Supabase, and a LangGraph recipe pipeline.

## Run locally

Install the backend dependencies from `backend/README.md`. Install the mobile dependencies from `mobile/` with `npm ci`.

Run the backend checks from `backend/`:

```sh
venv/bin/ruff check .
venv/bin/pytest
```

Run the mobile checks from `mobile/`:

```sh
npx tsc --noEmit
npm test -- --runInBand
```
