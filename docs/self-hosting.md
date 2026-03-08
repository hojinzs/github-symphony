# Self-hosting guide

This guide assumes a trusted operator running the control plane and allowing it to talk to the local Docker daemon through `/var/run/docker.sock`.

## 1. Prerequisites

- Docker Engine with Compose
- A trusted operator GitHub account for control-plane sign-in
- A dedicated machine-user GitHub account with access to the target organization
- Access to the repositories and GitHub Projects that Symphony should manage

## 2. Clone the repository

```bash
git clone <your-fork-or-repo-url>
cd github-symphony
```

## 3. Prepare the Docker Compose environment

Copy the sample env file:

```bash
cp docker-compose.env.example .env
```

Minimum values to set in `.env`:

- `DATABASE_URL`
- `CONTROL_PLANE_BASE_URL`
- `CONTROL_PLANE_RUNTIME_URL`
- `PLATFORM_SECRETS_KEY`
- `GITHUB_OPERATOR_CLIENT_ID`
- `GITHUB_OPERATOR_CLIENT_SECRET`
- `GITHUB_OPERATOR_ALLOWED_LOGINS` (optional)
- `WORKSPACE_RUNTIME_AUTH_SECRET`
- `SYMPHONY_IMAGE`
- `OPERATOR_SESSION_SECRET` (optional, otherwise `PLATFORM_SECRETS_KEY` is reused)

Generate the two non-GitHub secrets with a tool such as:

```bash
openssl rand -base64 32
```

Recommended local values:

- `CONTROL_PLANE_BASE_URL=http://localhost:3000`
- `CONTROL_PLANE_RUNTIME_URL=http://host.docker.internal:3000`
- `SYMPHONY_IMAGE=github-symphony-worker:local`

`PLATFORM_SECRETS_KEY` protects the stored machine-user PAT and agent credentials in PostgreSQL. `WORKSPACE_RUNTIME_AUTH_SECRET` derives workspace-scoped shared secrets so worker containers can refresh brokered GitHub credentials and fetch brokered agent credentials without ever receiving the control-plane secret material. `OPERATOR_SESSION_SECRET` can be set separately for signed operator sessions, but the control plane will fall back to `PLATFORM_SECRETS_KEY` when it is omitted.

## 4. Start the stack

```bash
docker compose up --build
```

What the stack does:

- starts PostgreSQL
- builds the local worker image from `docker/worker.Dockerfile`
- installs workspace dependencies inside the container
- runs `prisma generate`
- applies the current schema with `prisma db push`
- builds and starts the Next.js control plane on port `3000`

## 5. Bootstrap GitHub from the UI

Open:

```text
http://localhost:3000
```

Then complete the first-run setup flow:

1. Create or configure a dedicated GitHub OAuth App for trusted operators with callback URL `<CONTROL_PLANE_BASE_URL>/api/auth/github/callback`.
2. Open `/sign-in` and authenticate as a GitHub login listed in `GITHUB_OPERATOR_ALLOWED_LOGINS`.
3. Open `/setup/github` if you are not redirected there automatically.
4. Paste the dedicated machine-user PAT and the organization owner login into the default setup form.
5. Submit the form and wait for the control plane to validate actor lookup, repository inventory, and GitHub Project access.
6. Confirm the setup page shows the PAT integration as `ready`.

After setup reaches `ready`, workspace creation and issue submission stop asking for manual GitHub tokens.

## 6. Normal operator flow

Suggested first run:

1. Open `/workspaces/new`.
2. Register at least one ready agent credential from the workspace form.
3. Mark one ready credential as the platform default, or plan to select a workspace-specific override during workspace creation.
4. Enter prompt guidelines and allowed repositories.
5. Create the workspace. The control plane provisions the GitHub Project and worker runtime by using the configured machine-user PAT plus the selected effective agent credential, and writes the approval lifecycle mapping into `WORKFLOW.md`.
6. Ensure the target project exposes planning, human review, implementation, awaiting merge, and completed statuses that match the workspace workflow.
7. Open `/issues/new` and submit a task.
8. Review the plan comment the worker posts, then move the issue into the implementation-active state when you approve it.
9. Merge the linked pull request and confirm GitHub closes the issue and moves the project item into `Done`.

## 7. Recovery flow

If the stored machine-user PAT is revoked, rotated, or loses Project capability:

1. The control plane marks the integration `degraded`.
2. Workspace and issue creation redirect back to `/setup/github`.
3. Replace the PAT from the default setup form and target the same organization owner, or move to a new supported organization-backed machine user if ownership changed.
4. Existing workspace metadata remains in PostgreSQL so the operator can recover without rebuilding the control plane.

If an agent credential becomes invalid, revoked, or deleted:

1. The affected workspace shows a degraded or missing agent credential status on the dashboard.
2. New workspace creation is blocked when the selected effective credential is not ready.
3. New runtime launches are blocked until the operator rotates the credential, restores the platform default, or rebinds the workspace to another ready override.
4. Existing workspace metadata remains intact so the operator can recover without rewriting workflow files or repository state.

## 8. Operational notes

- The compose sample is intended for self-hosted single-host operation.
- Mounting `docker.sock` gives the control plane privileged access to the host Docker daemon.
- `CONTROL_PLANE_RUNTIME_URL` must be reachable from worker containers, not just from the operator browser.
- GitHub OAuth sign-in relies on `CONTROL_PLANE_BASE_URL` being the externally reachable browser URL.
- Keep GitHub linked-issue auto-close enabled; the implementation phase creates pull requests that rely on `Fixes #<issue-number>` for merge completion.
- Keep the project's built-in workflow automation enabled so closed issues advance into the completed project state.
- For internet-facing deployments, put a reverse proxy and TLS terminator in front of the app.
## References
- GitHub classic PAT scopes: https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens
