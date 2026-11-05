# How CI checks every change

GitHub Actions runs the `CI` workflow (`.github/workflows/ci.yml`) on every pull request and on every commit that reaches `main`. A PR is ready to merge when all three of its jobs pass. This page explains what each job checks, when the workflow runs, and how dependency updates arrive. Deployment is a separate workflow and is not covered here.

## Three jobs check the backend, the app, and the image

The jobs run in parallel, each on its own GitHub-hosted machine.

| Job | Checks | Fails on |
| --- | --- | --- |
| `Backend` | `ruff check .` and `pytest` in `backend/`, on Python 3.11 | A Ruff error or a failing test |
| `Mobile` | `npm run lint`, `npx tsc --noEmit`, and Jest in `mobile/`, on Node 22 | Any ESLint error or warning, a type error, or a failing test |
| `Docker build` | Builds `backend/Dockerfile` and pushes nothing | An image that does not build |

`npm run lint` runs ESLint with `eslint-config-expo` over all of `mobile/`. It allows zero warnings, so a stale hook dependency fails the build the same way a syntax error does.

The `Docker build` job exists because the production image can break while every test passes. A missing system package or a bad `COPY` path is invisible to `pytest`. The job builds the same Dockerfile that production uses, so the PR fails instead of the release. It caches image layers in GitHub Actions, so an unchanged dependency layer is not rebuilt.

## Each commit runs CI once

The workflow listens for two events:

- `pull_request` fires when you open a PR or push to its branch.
- `push` fires only for `main`, when a PR merges or someone pushes there directly.

Before this split, `push` fired for every branch. A commit on a PR branch then started two identical runs, one for each event. Limiting `push` to `main` removes the duplicate.

A branch with no open PR gets no CI. To get CI on unfinished work, open a draft PR.

## A newer push cancels the older run

If you push to a PR while its last run is still going, GitHub cancels that run and starts a new one. The cancelled run was testing a commit the PR no longer points at, so its result has no use.

Runs on `main` are never cancelled. Each one gets its own concurrency group, keyed by its run ID, so a later merge cannot replace it. Every commit on `main` gets a complete result.

## Dependabot sends weekly grouped updates

Dependabot (`.github/dependabot.yml`) checks Python (`backend/`), npm (`mobile/`), and GitHub Actions once a week. Each ecosystem gets one grouped PR with all its minor and patch updates. Each major update gets its own PR, because majors are the updates that need code changes, and one broken major should not block the safe ones.

Some npm packages must match the Expo SDK version: `expo`, `expo-*`, `react`, `react-native`, `jest`, `eslint`, `typescript`, and a few more listed in the config. Dependabot offers only patch updates for them. Upgrade the SDK by hand instead. The last section shows how.

A green Dependabot PR proves that the code still lints, type-checks, and passes its tests. It does not prove that the app runs on a phone, because Jest replaces native modules with mocks. Before you merge an update to a native package, run the app.

## Branch protection on `main` is not on yet

GitHub does not enforce any of this on `main` today. When branch protection is on, every change must reach `main` through a PR, and the `Backend`, `Mobile`, and `Docker build` checks must pass first. The rule applies to admins too. To see the current rules, open **Settings** > **Branches** on GitHub.

## Run the checks before you push

To catch failures before CI does, run the same commands locally.

1. Check the backend:

	```bash
	cd backend && ruff check . && pytest
	```

2. Check the app:

	```bash
	cd mobile && npm run lint && npx tsc --noEmit && npm test
	```

3. Build the image:

	```bash
	docker build backend
	```

When you open the PR, fill in every section of the template. Under **How it was tested**, list the commands you ran and what you saw.

## Upgrade the Expo SDK by hand

To move `mobile/` to the latest Expo SDK, run:

```bash
cd mobile && npx expo install expo@latest && npx expo install --fix
```

The second command moves every SDK-matched package to the version that the new SDK expects. Then run the checks above and the app itself.
