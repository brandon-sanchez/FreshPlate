# Set up automatic deploys to Cloud Run

After this one-time setup, every push to `main` that passes CI deploys the API to the `freshplate-api` Cloud Run service. The `Deploy` workflow in `.github/workflows/deploy.yml` signs in to Google Cloud with a short-lived GitHub token, so no service account key exists anywhere. For what the workflow does and every name it uses, see [Cloud Run deployment reference](deployment-reference.md).

You need `gcloud` and `gh`, both signed in, the Owner role on the Google Cloud project, and admin access to the GitHub repository. Run the blocks in order, from the repository root, in one bash or zsh session. Each block uses variables that step 1 sets.

If a block fails partway, fix the cause and run the block again. A `create` command for a resource that already exists prints an "already exists" error and leaves the resource unchanged. To change an existing resource, use its `update` or `set-` command.

## 1. Set the shell variables

Replace `your-project-id` and `us-east1` with your project ID and region. The other variables come from those two values and from GitHub.

```bash
export FRESHPLATE_PROJECT_ID='your-project-id'
export FRESHPLATE_REGION='us-east1'
export FRESHPLATE_REPO='brandon-sanchez/FreshPlate'
export FRESHPLATE_PROJECT_NUMBER="$(gcloud projects describe "$FRESHPLATE_PROJECT_ID" --format='value(projectNumber)')"
export FRESHPLATE_REPO_ID="$(gh api "repos/$FRESHPLATE_REPO" --jq .id)"
export FRESHPLATE_OWNER_ID="$(gh api "repos/$FRESHPLATE_REPO" --jq .owner.id)"
export FRESHPLATE_DEPLOYER_EMAIL="github-deployer@$FRESHPLATE_PROJECT_ID.iam.gserviceaccount.com"
export FRESHPLATE_RUNTIME_EMAIL="freshplate-runtime@$FRESHPLATE_PROJECT_ID.iam.gserviceaccount.com"
export FRESHPLATE_BUILD_EMAIL="freshplate-cloud-build@$FRESHPLATE_PROJECT_ID.iam.gserviceaccount.com"
export FRESHPLATE_PROVIDER_RESOURCE="projects/$FRESHPLATE_PROJECT_NUMBER/locations/global/workloadIdentityPools/github/providers/github-oidc"
gcloud config set project "$FRESHPLATE_PROJECT_ID"
echo "$FRESHPLATE_PROJECT_NUMBER $FRESHPLATE_REPO_ID $FRESHPLATE_OWNER_ID"
```

The last command prints three numbers. If any is missing, check that `gcloud` and `gh` are signed in, then run the block again.

## 2. Enable the APIs

```bash
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com secretmanager.googleapis.com iam.googleapis.com iamcredentials.googleapis.com sts.googleapis.com serviceusage.googleapis.com
```

## 3. Create the service accounts

```bash
gcloud iam service-accounts create github-deployer --display-name='FreshPlate GitHub deployer'
gcloud iam service-accounts create freshplate-runtime --display-name='FreshPlate Cloud Run runtime'
gcloud iam service-accounts create freshplate-cloud-build --display-name='FreshPlate Cloud Build builder'
```

## 4. Let GitHub sign in as the deployer

This block creates a Workload Identity Federation pool and provider for GitHub. The provider accepts a token only from the `Deploy` workflow on `main` of this repository, running in the `production` environment. It also matches the repository and owner by numeric ID, because someone else could later create a repository with the same name.

```bash
gcloud iam workload-identity-pools create github --location=global --display-name='FreshPlate GitHub'
gcloud iam workload-identity-pools providers create-oidc github-oidc \
  --location=global \
  --workload-identity-pool=github \
  --display-name='GitHub Actions' \
  --issuer-uri='https://token.actions.githubusercontent.com' \
  --attribute-mapping='google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.repository_id=assertion.repository_id,attribute.repository_owner_id=assertion.repository_owner_id,attribute.ref=assertion.ref,attribute.event_name=assertion.event_name,attribute.environment=assertion.environment,attribute.workflow_ref=assertion.workflow_ref' \
  --attribute-condition="assertion.repository_id == '$FRESHPLATE_REPO_ID' && assertion.repository_owner_id == '$FRESHPLATE_OWNER_ID' && assertion.ref == 'refs/heads/main' && assertion.event_name == 'workflow_run' && assertion.environment == 'production' && assertion.workflow_ref == '$FRESHPLATE_REPO/.github/workflows/deploy.yml@refs/heads/main'"
gcloud iam service-accounts add-iam-policy-binding "$FRESHPLATE_DEPLOYER_EMAIL" \
  --role=roles/iam.workloadIdentityUser \
  --member="principalSet://iam.googleapis.com/projects/$FRESHPLATE_PROJECT_NUMBER/locations/global/workloadIdentityPools/github/attribute.repository_id/$FRESHPLATE_REPO_ID"
```

## 5. Grant the deploy and build roles

These are the roles that Google documents for deploying from source. The deployer cannot change IAM policy, so it cannot make the service public. You do that once in step 8.

```bash
gcloud projects add-iam-policy-binding "$FRESHPLATE_PROJECT_ID" --member="serviceAccount:$FRESHPLATE_DEPLOYER_EMAIL" --role=roles/run.sourceDeveloper --condition=None
gcloud projects add-iam-policy-binding "$FRESHPLATE_PROJECT_ID" --member="serviceAccount:$FRESHPLATE_DEPLOYER_EMAIL" --role=roles/serviceusage.serviceUsageConsumer --condition=None
gcloud projects add-iam-policy-binding "$FRESHPLATE_PROJECT_ID" --member="serviceAccount:$FRESHPLATE_BUILD_EMAIL" --role=roles/run.builder --condition=None
gcloud iam service-accounts add-iam-policy-binding "$FRESHPLATE_RUNTIME_EMAIL" --member="serviceAccount:$FRESHPLATE_DEPLOYER_EMAIL" --role=roles/iam.serviceAccountUser
gcloud iam service-accounts add-iam-policy-binding "$FRESHPLATE_BUILD_EMAIL" --member="serviceAccount:$FRESHPLATE_DEPLOYER_EMAIL" --role=roles/iam.serviceAccountUser
```

## 6. Create the image repository

Cloud Run pushes each build to an Artifact Registry repository named `cloud-run-source-deploy`, and creates that repository on the first deploy if it does not exist. Create it now so that you can attach a cleanup policy. The policy keeps the two newest images and deletes older ones, so storage does not grow with every push to `main`.

```bash
gcloud artifacts repositories create cloud-run-source-deploy --repository-format=docker --location="$FRESHPLATE_REGION" --description='Cloud Run source deploy images'
cat > /tmp/freshplate-cleanup-policy.json <<'JSON'
[
  {"name": "keep-two-newest", "action": {"type": "Keep"}, "mostRecentVersions": {"keepCount": 2}},
  {"name": "delete-older", "action": {"type": "Delete"}, "condition": {"tagState": "any", "olderThan": "1d"}}
]
JSON
gcloud artifacts repositories set-cleanup-policies cloud-run-source-deploy --location="$FRESHPLATE_REGION" --policy=/tmp/freshplate-cleanup-policy.json --no-dry-run
```

## 7. Store the secrets

This block reads each value from `backend/.env` and pipes it into Secret Manager. No value appears on screen or in shell history. Each line in `backend/.env` must be a plain `KEY=value`, with no `export` and no trailing comment.

The block skips a secret that already has an enabled version. It stops at the first key that is missing or empty.

```bash
freshplate_env_value() { sed -n "s/^$1=//p" backend/.env | tail -n 1 | tr -d '\r\n' | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/"; }
for pair in GEMINI_API_KEY:gemini-api-key SUPABASE_URL:supabase-url SUPABASE_PUBLISHABLE_KEY:supabase-publishable-key SUPABASE_SECRET_KEY:supabase-secret-key LANGSMITH_API_KEY:langsmith-api-key; do
  env_name="${pair%%:*}"
  secret_name="${pair#*:}"
  if [ -z "$(freshplate_env_value "$env_name")" ]; then
    echo "$env_name is missing from backend/.env" >&2
    break
  fi
  gcloud secrets describe "$secret_name" >/dev/null 2>&1 || gcloud secrets create "$secret_name" --replication-policy=automatic
  if [ -z "$(gcloud secrets versions list "$secret_name" --filter=state=enabled --limit=1 --format='value(name)')" ]; then
    freshplate_env_value "$env_name" | gcloud secrets versions add "$secret_name" --data-file=-
  fi
  gcloud secrets add-iam-policy-binding "$secret_name" --member="serviceAccount:$FRESHPLATE_RUNTIME_EMAIL" --role=roles/secretmanager.secretAccessor --condition=None >/dev/null
done
gcloud secrets list --format='table(name)'
```

To give production a different value from local development, run `gcloud secrets versions add <secret> --data-file=-`, paste the value, and press Ctrl-D.

## 8. Deploy once and make the service public

The mobile app calls the API directly, and the API checks the Supabase JWT on each request, so the service must accept unauthenticated calls. The `--allow-unauthenticated` flag grants `roles/run.invoker` to `allUsers`. Later deploys from GitHub keep that grant.

This deploy builds the backend in your current checkout. The next push to `main` replaces it with the merged code.

```bash
gcloud run deploy freshplate-api --region="$FRESHPLATE_REGION" --source=backend \
  --service-account="$FRESHPLATE_RUNTIME_EMAIL" \
  --build-service-account="projects/$FRESHPLATE_PROJECT_ID/serviceAccounts/$FRESHPLATE_BUILD_EMAIL" \
  --port=8080 --memory=512Mi --min-instances=0 --max-instances=2 \
  --set-env-vars='LANGSMITH_TRACING=true,LANGSMITH_PROJECT=freshplate' \
  --set-secrets='GEMINI_API_KEY=gemini-api-key:latest,SUPABASE_URL=supabase-url:latest,SUPABASE_PUBLISHABLE_KEY=supabase-publishable-key:latest,SUPABASE_SECRET_KEY=supabase-secret-key:latest,LANGSMITH_API_KEY=langsmith-api-key:latest' \
  --allow-unauthenticated
curl --fail --silent --show-error "$(gcloud run services describe freshplate-api --region="$FRESHPLATE_REGION" --format='value(status.url)')/health"
```

The `curl` command prints `{"status":"healthy","service":"freshplate-api"}`.

## 9. Create the production environment

The `Deploy` workflow runs in a GitHub environment named `production` and reads its variables from there. The first command creates the environment, and the next two allow only `main` to deploy to it.

```bash
gh api -X PUT "repos/$FRESHPLATE_REPO/environments/production" -F 'deployment_branch_policy[protected_branches]=false' -F 'deployment_branch_policy[custom_branch_policies]=true'
gh api -X POST "repos/$FRESHPLATE_REPO/environments/production/deployment-branch-policies" -f name=main -f type=branch
gh variable set GCP_PROJECT_ID --repo="$FRESHPLATE_REPO" --env=production --body="$FRESHPLATE_PROJECT_ID"
gh variable set GCP_REGION --repo="$FRESHPLATE_REPO" --env=production --body="$FRESHPLATE_REGION"
gh variable set GCP_WORKLOAD_IDENTITY_PROVIDER --repo="$FRESHPLATE_REPO" --env=production --body="$FRESHPLATE_PROVIDER_RESOURCE"
gh variable set GCP_DEPLOY_SERVICE_ACCOUNT --repo="$FRESHPLATE_REPO" --env=production --body="$FRESHPLATE_DEPLOYER_EMAIL"
gh variable set GCP_CLOUD_RUN_SERVICE_ACCOUNT --repo="$FRESHPLATE_REPO" --env=production --body="$FRESHPLATE_RUNTIME_EMAIL"
gh variable set GCP_CLOUD_BUILD_SERVICE_ACCOUNT --repo="$FRESHPLATE_REPO" --env=production --body="$FRESHPLATE_BUILD_EMAIL"
gh variable list --repo="$FRESHPLATE_REPO" --env=production
```

The list shows all six variables. Setup is done, and the next push to `main` that passes CI deploys.

To require your approval before each deploy, add yourself as a required reviewer under **Settings**, **Environments**, **production** in GitHub.

## 10. Add a budget alert

This step is optional. The budget emails you at 50% and 100% of $5 a month. It does not stop spending.

```bash
gcloud services enable billingbudgets.googleapis.com
gcloud billing budgets create \
  --billing-account="$(gcloud billing projects describe "$FRESHPLATE_PROJECT_ID" --format='value(billingAccountName)' | sed 's|billingAccounts/||')" \
  --display-name='FreshPlate' \
  --budget-amount=5USD \
  --filter-projects="projects/$FRESHPLATE_PROJECT_ID" \
  --threshold-rule=percent=0.5 \
  --threshold-rule=percent=1.0
```

## Check a deployment

To see the live URL and the revision that serves it, and the last five deploy runs, run:

```bash
gcloud run services describe freshplate-api --region="$FRESHPLATE_REGION" --format='value(status.url,status.latestReadyRevisionName)'
gh run list --repo="$FRESHPLATE_REPO" --workflow=Deploy --limit=5
```

## Rotate a secret

To replace a secret's value, set `FRESHPLATE_SECRET` to the secret name and run the block. Paste the new value and press Ctrl-D. The block then disables every older enabled version, so they stop counting against the free tier.

```bash
export FRESHPLATE_SECRET='gemini-api-key'
gcloud secrets versions add "$FRESHPLATE_SECRET" --data-file=-
gcloud secrets versions list "$FRESHPLATE_SECRET" --filter=state=enabled --sort-by=~createTime --format='value(name)' | tail -n +2 | xargs -I{} gcloud secrets versions disable {} --secret="$FRESHPLATE_SECRET"
```

Running instances keep the old value. The next deploy, from a push to `main` or the step 8 command, starts instances that read the new value.
