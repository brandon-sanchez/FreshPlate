# Deploy FreshPlate to Cloud Run

The `deploy` job in `.github/workflows/ci.yml` runs after the backend and mobile jobs, and only after a push to `main`. It uses GitHub OIDC and Workload Identity Federation, then runs Cloud Run source deployment. No service-account key is stored in GitHub. Deployments are serialized; after a queued job acquires the slot it checks that its commit is still `main`, so an older push cannot deploy after a newer push. An already-running Cloud Build is allowed to finish; the workflow never assumes that cancelling the GitHub job cancels the remote build.

## One-time Google Cloud setup

Run these commands from a shell with an administrator account. They use task-prefixed variables so they do not overwrite common shell variables. `gcloud` and `gh` below are current stable CLIs; pin/update them in your build image or runner policy if you need reproducibility.

```bash
export FRESHPLATE_PROJECT_ID='your-project-id'
export FRESHPLATE_REGION='us-central1'
export FRESHPLATE_PROJECT_NUMBER="$(gcloud projects describe "$FRESHPLATE_PROJECT_ID" --format='value(projectNumber)')"
export FRESHPLATE_REPO_OWNER='brandon-sanchez'
export FRESHPLATE_REPO_NAME='FreshPlate'
export FRESHPLATE_REPO_ID='REPLACE_WITH_GITHUB_REPOSITORY_NUMERIC_ID'
export FRESHPLATE_OWNER_ID='REPLACE_WITH_GITHUB_OWNER_NUMERIC_ID'
export FRESHPLATE_DEPLOYER_SA='github-deployer'
export FRESHPLATE_RUNTIME_SA='freshplate-runtime'
export FRESHPLATE_BUILD_SA='freshplate-cloud-build'
export FRESHPLATE_POOL='github'
export FRESHPLATE_PROVIDER='github-oidc'
gcloud config set project "$FRESHPLATE_PROJECT_ID"
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com secretmanager.googleapis.com iamcredentials.googleapis.com iam.googleapis.com serviceusage.googleapis.com
```

The repository and owner numeric IDs are available from GitHub's repository and organization API. They are deliberately required below because a repository name alone is mutable.

```bash
gcloud iam service-accounts create "$FRESHPLATE_DEPLOYER_SA" --display-name='FreshPlate GitHub deployer'
gcloud iam service-accounts create "$FRESHPLATE_RUNTIME_SA" --display-name='FreshPlate Cloud Run runtime'
gcloud iam service-accounts create "$FRESHPLATE_BUILD_SA" --display-name='FreshPlate Cloud Build builder'
export FRESHPLATE_DEPLOYER_EMAIL="$FRESHPLATE_DEPLOYER_SA@$FRESHPLATE_PROJECT_ID.iam.gserviceaccount.com"
export FRESHPLATE_RUNTIME_EMAIL="$FRESHPLATE_RUNTIME_SA@$FRESHPLATE_PROJECT_ID.iam.gserviceaccount.com"
export FRESHPLATE_BUILD_EMAIL="$FRESHPLATE_BUILD_SA@$FRESHPLATE_PROJECT_ID.iam.gserviceaccount.com"
gcloud iam workload-identity-pools create "$FRESHPLATE_POOL" --location=global --display-name='FreshPlate GitHub'
gcloud iam workload-identity-pools providers create-oidc "$FRESHPLATE_PROVIDER" --location=global --workload-identity-pool="$FRESHPLATE_POOL" --issuer-uri='https://token.actions.githubusercontent.com' --attribute-mapping='google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.repository_id=assertion.repository_id,attribute.repository_owner_id=assertion.repository_owner_id,attribute.ref=assertion.ref,attribute.event_name=assertion.event_name' --attribute-condition="assertion.repository_id == '$FRESHPLATE_REPO_ID' && assertion.repository_owner_id == '$FRESHPLATE_OWNER_ID' && assertion.ref == 'refs/heads/main' && assertion.event_name == 'push'"
export FRESHPLATE_PROVIDER_RESOURCE="projects/$FRESHPLATE_PROJECT_NUMBER/locations/global/workloadIdentityPools/$FRESHPLATE_POOL/providers/$FRESHPLATE_PROVIDER"
export FRESHPLATE_PRINCIPAL_SET="principalSet://iam.googleapis.com/projects/$FRESHPLATE_PROJECT_NUMBER/locations/global/workloadIdentityPools/$FRESHPLATE_POOL/attribute.repository_id/$FRESHPLATE_REPO_ID"
gcloud iam service-accounts add-iam-policy-binding "$FRESHPLATE_DEPLOYER_EMAIL" --role=roles/iam.workloadIdentityUser --member="$FRESHPLATE_PRINCIPAL_SET"
```

Grant the least-privilege deployment and build permissions. `run.sourceDeveloper` and `serviceusage.serviceUsageConsumer` are the documented source-deploy roles. `run.builder` is required by the user-specified build identity; the deployer may act as that builder and the runtime identity. The `setIamPolicy` permission needed by `--allow-unauthenticated` is intentionally scoped to this service, or omit that flag and keep the service private.

```bash
gcloud projects add-iam-policy-binding "$FRESHPLATE_PROJECT_ID" --member="serviceAccount:$FRESHPLATE_DEPLOYER_EMAIL" --role=roles/run.sourceDeveloper
gcloud projects add-iam-policy-binding "$FRESHPLATE_PROJECT_ID" --member="serviceAccount:$FRESHPLATE_DEPLOYER_EMAIL" --role=roles/serviceusage.serviceUsageConsumer
gcloud projects add-iam-policy-binding "$FRESHPLATE_PROJECT_ID" --member="serviceAccount:$FRESHPLATE_BUILD_EMAIL" --role=roles/run.builder
gcloud iam service-accounts add-iam-policy-binding "$FRESHPLATE_RUNTIME_EMAIL" --member="serviceAccount:$FRESHPLATE_DEPLOYER_EMAIL" --role=roles/iam.serviceAccountUser
gcloud iam service-accounts add-iam-policy-binding "$FRESHPLATE_BUILD_EMAIL" --member="serviceAccount:$FRESHPLATE_DEPLOYER_EMAIL" --role=roles/iam.serviceAccountUser
```

The public invoker grant is applied after the first successful deployment below. This keeps the bootstrap sequence valid before the service exists and scopes the grant to `freshplate-api`; the deployer does not receive project-wide `roles/run.admin`. If organization policy forbids public services, omit that grant and deploy without public access.

Create or update these secrets from protected local files or stdin. Never put values in this document, shell history, GitHub logs, or the repository. `gcloud secrets versions add` creates a new version and does not overwrite existing versions.

```bash
for secret_name in gemini-api-key supabase-url supabase-publishable-key supabase-secret-key langsmith-api-key; do
  gcloud secrets describe "$secret_name" >/dev/null 2>&1 || gcloud secrets create "$secret_name" --replication-policy=automatic
  gcloud secrets add-iam-policy-binding "$secret_name" --member="serviceAccount:$FRESHPLATE_RUNTIME_EMAIL" --role=roles/secretmanager.secretAccessor
done
# Read each value from a protected local file, for example:
gcloud secrets versions add gemini-api-key --data-file=/secure/path/gemini-api-key
gcloud secrets versions add supabase-url --data-file=/secure/path/supabase-url
gcloud secrets versions add supabase-publishable-key --data-file=/secure/path/supabase-publishable-key
gcloud secrets versions add supabase-secret-key --data-file=/secure/path/supabase-secret-key
gcloud secrets versions add langsmith-api-key --data-file=/secure/path/langsmith-api-key
```

Add these repository variables in GitHub:

`GCP_PROJECT_ID`, `GCP_REGION`, `GCP_WORKLOAD_IDENTITY_PROVIDER`, `GCP_DEPLOY_SERVICE_ACCOUNT`, `GCP_CLOUD_RUN_SERVICE_ACCOUNT`, and `GCP_CLOUD_BUILD_SERVICE_ACCOUNT`.

Use the full provider resource name for the provider variable. Use service-account email addresses for all three service-account variables.

```bash
gh variable set GCP_PROJECT_ID --repo="$FRESHPLATE_REPO_OWNER/$FRESHPLATE_REPO_NAME" --body="$FRESHPLATE_PROJECT_ID"
gh variable set GCP_REGION --repo="$FRESHPLATE_REPO_OWNER/$FRESHPLATE_REPO_NAME" --body="$FRESHPLATE_REGION"
gh variable set GCP_WORKLOAD_IDENTITY_PROVIDER --repo="$FRESHPLATE_REPO_OWNER/$FRESHPLATE_REPO_NAME" --body="$FRESHPLATE_PROVIDER_RESOURCE"
gh variable set GCP_DEPLOY_SERVICE_ACCOUNT --repo="$FRESHPLATE_REPO_OWNER/$FRESHPLATE_REPO_NAME" --body="$FRESHPLATE_DEPLOYER_EMAIL"
gh variable set GCP_CLOUD_RUN_SERVICE_ACCOUNT --repo="$FRESHPLATE_REPO_OWNER/$FRESHPLATE_REPO_NAME" --body="$FRESHPLATE_RUNTIME_EMAIL"
gh variable set GCP_CLOUD_BUILD_SERVICE_ACCOUNT --repo="$FRESHPLATE_REPO_OWNER/$FRESHPLATE_REPO_NAME" --body="$FRESHPLATE_BUILD_EMAIL"
```

## Manual deploy

```bash
gcloud run deploy freshplate-api --project="$FRESHPLATE_PROJECT_ID" --region="$FRESHPLATE_REGION" --source=backend/ --service-account="$FRESHPLATE_RUNTIME_EMAIL" --build-service-account="projects/$FRESHPLATE_PROJECT_ID/serviceAccounts/$FRESHPLATE_BUILD_EMAIL" --port=8080 --memory=512Mi --min-instances=0 --max-instances=2 --set-env-vars='LANGCHAIN_TRACING_V2=true,LANGCHAIN_PROJECT=freshplate' --set-secrets='GEMINI_API_KEY=gemini-api-key:latest,SUPABASE_URL=supabase-url:latest,SUPABASE_PUBLISHABLE_KEY=supabase-publishable-key:latest,SUPABASE_SECRET_KEY=supabase-secret-key:latest,LANGSMITH_API_KEY=langsmith-api-key:latest'
gcloud run services add-iam-policy-binding freshplate-api --project="$FRESHPLATE_PROJECT_ID" --region="$FRESHPLATE_REGION" --member=allUsers --role=roles/run.invoker
```

The workflow uses the public access bootstrap described above, port `8080`, 512 MiB memory, zero minimum instances, and two maximum instances. This is a small free-tier-oriented configuration, not a guarantee of zero cost: Cloud Run, Cloud Build, Artifact Registry, Secret Manager, networking, and quotas vary by region and account, and usage beyond free allowances is billed. Verify the deployed service and revision with `gcloud run services describe freshplate-api --region="$FRESHPLATE_REGION" --format='value(status.url,status.latestReadyRevisionName)'` and `curl --fail --silent --show-error "$(gcloud run services describe freshplate-api --region="$FRESHPLATE_REGION" --format='value(status.url)')/health"`.
