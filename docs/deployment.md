# Deploy FreshPlate to Cloud Run

The `deploy` job in `.github/workflows/ci.yml` runs after the backend and mobile jobs, and only after a push to `main`. It uses GitHub OIDC and Workload Identity Federation, then runs `gcloud run deploy --source backend`. No service-account key is stored in GitHub.

## One-time Google Cloud setup

Set `PROJECT_ID` and `PROJECT_NUMBER` to the project values. Enable Cloud Run, Cloud Build, Secret Manager, and IAM Credentials APIs.

Create separate `github-deployer` and `freshplate-runtime` service accounts. Create a global workload identity pool named `github` and an OIDC provider named `github-oidc` with issuer `https://token.actions.githubusercontent.com`. Map `google.subject=assertion.sub` and `attribute.repository=assertion.repository`, then restrict the provider with `assertion.repository=='brandon-sanchez/FreshPlate'`.

Allow the repository principal set to impersonate `github-deployer` with `roles/iam.workloadIdentityUser`. Grant `github-deployer` `roles/run.admin` and `roles/cloudbuild.builds.editor`. Grant it `roles/iam.serviceAccountUser` on `freshplate-runtime` only. These identities keep build deployment separate from application runtime.

Create these Secret Manager secrets: `gemini-api-key`, `supabase-url`, `supabase-publishable-key`, `supabase-secret-key`, and `langsmith-api-key`. Grant `roles/secretmanager.secretAccessor` on each secret to `freshplate-runtime`.

Add these repository variables in GitHub:

`GCP_PROJECT_ID`, `GCP_REGION`, `GCP_WORKLOAD_IDENTITY_PROVIDER`, `GCP_DEPLOY_SERVICE_ACCOUNT`, and `GCP_CLOUD_RUN_SERVICE_ACCOUNT`.

Use the full provider resource name for the provider variable. Use service-account email addresses for the two service-account variables.

## Manual deploy

`gcloud run deploy freshplate-api --source backend/ --service-account freshplate-runtime@PROJECT_ID.iam.gserviceaccount.com` uses Cloud Build to build the backend image. Bind the same five secrets to `GEMINI_API_KEY`, `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY`, and `LANGSMITH_API_KEY`. Set `LANGCHAIN_TRACING_V2=true` and `LANGCHAIN_PROJECT=freshplate`.

The workflow uses `--allow-unauthenticated`, port `8080`, 512 MiB memory, zero minimum instances, and two maximum instances.
