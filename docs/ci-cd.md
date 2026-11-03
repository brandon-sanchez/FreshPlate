# CI/CD

This guide explains what runs automatically on FreshPlate, when it runs, and why. Deployment to Cloud Run is a separate workflow with its own guide, `docs/deployment.md`.

## What runs

The `CI` workflow (`.github/workflows/ci.yml`) has three jobs. They run in parallel on separate GitHub-hosted machines.

| Job | What it checks | Fails when |
| --- | --- | --- |
| Backend | `ruff check .` and `pytest` in `backend/` on Python 3.11 | A lint rule is broken or a test fails |
| Mobile | `npm run lint` (ESLint with `eslint-config-expo`), `tsc --noEmit`, and Jest in `mobile/` on Node 22 | Any lint error or warning, a type error, or a failing test |
| Docker build | Builds `backend/Dockerfile` without pushing it | The production image does not build |

The Docker build job catches a broken image on the PR, before deploy tries to build the same Dockerfile. It uses the GitHub Actions cache, so unchanged layers are not rebuilt.

## When it runs

CI runs exactly once for each commit.

- **A push to a PR branch** triggers the `pull_request` event. The `push` trigger is limited to `main`, so the same commit does not also start a second run.
- **A merge or push to `main`** triggers the `push` event.

A branch with no open PR gets no CI run. Open a draft PR to get CI on work in progress.

If you push to a PR again before its last run finishes, the older run is cancelled. Its result would describe a commit that is no longer the PR's latest. Runs on `main` are never cancelled, because deploy waits for CI on `main` to pass.

## Before you open a PR

Run the same checks locally:

```bash
cd backend && ruff check . && pytest
```

```bash
cd mobile && npm run lint && npx tsc --noEmit && npm test
```

```bash
docker build backend
```

Fill in every section of the PR template (`.github/pull_request_template.md`). "How it was tested" should name the commands you ran and what you saw.

## Protecting `main`

Branch protection on `main` is planned but not turned on yet. When it is on, every change reaches `main` through a pull request, and the Backend, Mobile, and Docker build checks must pass before it can merge. Admins follow the same rule. Check the current rules under **Settings > Branches** on GitHub.

## Dependency updates

Dependabot (`.github/dependabot.yml`) checks for updates every week for Python (`backend/`), npm (`mobile/`), and GitHub Actions. Each ecosystem gets one grouped PR for minor and patch updates. A major update arrives as its own PR, because it is more likely to need code changes.

CI runs on these PRs like any other. A green run means the code still lints, type-checks, and passes tests. It does not prove the app works on a device, because Jest mocks native modules. Run the app before you merge a PR that touches native packages.

Packages tied to the Expo SDK (`expo`, `expo-*`, `react`, `react-native`, `jest`, `eslint`, `typescript`, and related ones) only get patch updates from Dependabot. These packages must stay on versions that match the Expo SDK, so upgrade the SDK by hand:

```bash
cd mobile && npx expo install expo@latest && npx expo install --fix
```
