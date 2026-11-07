# Cloud Run deployment reference

The `Deploy` workflow in `.github/workflows/deploy.yml` deploys the backend to Cloud Run. To create the Google Cloud resources and the GitHub environment it needs, follow [Set up automatic deploys to Cloud Run](deployment.md).

## Deploy workflow

- Starts when a `CI` workflow run on `main` completes. The workflow continues only if that CI run succeeded, was triggered by a push, and ran on this repository rather than a fork.
- Checks out and deploys the commit that CI tested, `github.event.workflow_run.head_sha`.
- Runs in the `production` GitHub environment and reads its variables from there. Only `main` can deploy to that environment.
- Runs one deploy at a time. Before deploying, a separate `freshness` job checks through the GitHub API that the tested commit is still the tip of `main`. If it is not, the deploy is skipped, so an older commit never replaces a newer one, and a skipped run never creates a `production` deployment.
- Fails at its first deploy step, and names each missing variable, if any `production` variable is unset.
- Gets a short-lived GitHub OIDC token, then signs in to Google Cloud as `github-deployer` through Workload Identity Federation. No service account key exists.
- Runs `gcloud run deploy --source=backend`. Cloud Build builds the image from `backend/Dockerfile`, and `backend/.gcloudignore` keeps `.env`, tests, and local data out of the upload.
- Calls `/health` on the new revision up to five times, 10 seconds apart. The job fails if no call returns 200 with `"service": "freshplate-api"` in the body.

## Google Cloud resources

| Name | Kind | Purpose |
| --- | --- | --- |
| `freshplate-api` | Cloud Run service | Runs the FastAPI backend. Public, 512 MiB, 0 to 2 instances, port 8080. |
| `github-deployer` | Service account | Deploys the service from GitHub. |
| `freshplate-cloud-build` | Service account | Builds the image and pushes it to Artifact Registry. |
| `freshplate-runtime` | Service account | Runs the container and reads the app secrets. |
| `github` | Workload identity pool | Holds the GitHub provider. |
| `github-oidc` | Workload identity provider | Accepts GitHub tokens only from `deploy.yml` on `main` of this repository, in the `production` environment, triggered by `workflow_run`. |
| `cloud-run-source-deploy` | Artifact Registry repository | Stores built images. Keeps the two newest. |

## IAM roles

| Member | Role | Granted on |
| --- | --- | --- |
| GitHub `principalSet` for this repository | `roles/iam.workloadIdentityUser` | `github-deployer` |
| `github-deployer` | `roles/run.sourceDeveloper` | Project |
| `github-deployer` | `roles/serviceusage.serviceUsageConsumer` | Project |
| `github-deployer` | `roles/iam.serviceAccountUser` | `freshplate-runtime` and `freshplate-cloud-build` |
| `freshplate-cloud-build` | `roles/run.builder` | Project |
| `freshplate-runtime` | `roles/secretmanager.secretAccessor` | Each app secret |
| `allUsers` | `roles/run.invoker` | `freshplate-api` |

## Environment

The container gets each secret's `latest` version as an environment variable.

| Environment variable | Secret Manager secret |
| --- | --- |
| `GEMINI_API_KEY` | `gemini-api-key` |
| `SUPABASE_URL` | `supabase-url` |
| `SUPABASE_PUBLISHABLE_KEY` | `supabase-publishable-key` |
| `SUPABASE_SECRET_KEY` | `supabase-secret-key` |
| `LANGSMITH_API_KEY` | `langsmith-api-key` |

The workflow also sets `LANGSMITH_TRACING=true` and `LANGSMITH_PROJECT=freshplate`. It does not set `IMAGE_GENERATION_ENABLED`, so image generation is off and the service needs no `OPENAI_API_KEY`.

## GitHub environment

The `production` environment allows deploys only from `main`. It holds these variables, which are identifiers, not secrets.

| Variable | Value |
| --- | --- |
| `GCP_PROJECT_ID` | The project ID. |
| `GCP_REGION` | The Cloud Run region. |
| `GCP_WORKLOAD_IDENTITY_PROVIDER` | `projects/<project-number>/locations/global/workloadIdentityPools/github/providers/github-oidc` |
| `GCP_DEPLOY_SERVICE_ACCOUNT` | The `github-deployer` email. |
| `GCP_CLOUD_RUN_SERVICE_ACCOUNT` | The `freshplate-runtime` email. |
| `GCP_CLOUD_BUILD_SERVICE_ACCOUNT` | The `freshplate-cloud-build` email. |

## Cost

Light traffic fits within Cloud Run's free tier, because the service scales to zero and runs at most two instances. Google bills these items past their free tiers:

- Cloud Build minutes.
- Artifact Registry storage above 0.5 GB.
- Secret Manager versions above six active, and access calls above the free count.
- Network egress.

Each deploy also uploads a source archive to a Cloud Storage bucket that Cloud Run creates for source deploys. Nothing deletes these archives.
