# Self-hosting guide

This guide assumes a trusted operator running the control plane and allowing it to talk to the local Docker daemon through `/var/run/docker.sock`.

## 1. Prerequisites

- Docker Engine with Compose
- A GitHub account that can create and install GitHub Apps in the target user or organization
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
- `GITHUB_APP_SECRETS_KEY`
- `WORKSPACE_RUNTIME_AUTH_SECRET`
- `SYMPHONY_IMAGE`

Generate the two non-GitHub secrets with a tool such as:

```bash
openssl rand -base64 32
```

Recommended local values:

- `CONTROL_PLANE_BASE_URL=http://localhost:3000`
- `CONTROL_PLANE_RUNTIME_URL=http://host.docker.internal:3000`
- `SYMPHONY_IMAGE=github-symphony-worker:local`

`GITHUB_APP_SECRETS_KEY` encrypts stored GitHub App credentials in PostgreSQL. `WORKSPACE_RUNTIME_AUTH_SECRET` derives workspace-scoped shared secrets so worker containers can refresh short-lived installation tokens without ever receiving the app private key.

The GitHub App installation must grant:

- `Contents: Read and write`
- `Issues: Read and write`
- `Pull requests: Read and write`
- `Repository projects: Read and write`
- `Organization projects: Read and write`

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

## 5. Bootstrap the GitHub App from the UI

Open:

```text
http://localhost:3000
```

Then complete the first-run setup flow:

1. Open `/setup/github-app` if you are not redirected there automatically.
2. Click `Start setup`.
3. GitHub opens the manifest flow and creates the app using the control-plane callback and setup URLs.
4. Install the app into the target user or organization.
5. GitHub redirects back to the control plane, which verifies the installation and stores the encrypted app credentials.

After setup reaches `ready`, workspace creation and issue submission stop asking for manual GitHub tokens.

## 6. Normal operator flow

Suggested first run:

1. Open `/workspaces/new`.
2. Enter prompt guidelines and allowed repositories.
3. Create the workspace. The control plane provisions the GitHub Project and worker runtime by using app-backed installation credentials and writes the approval lifecycle mapping into `WORKFLOW.md`.
4. Ensure the target project exposes planning, human review, implementation, awaiting merge, and completed statuses that match the workspace workflow.
5. Open `/issues/new` and submit a task.
6. Review the plan comment the worker posts, then move the issue into the implementation-active state when you approve it.
7. Merge the linked pull request and confirm GitHub closes the issue and moves the project item into `Done`.

## 7. Recovery flow

If GitHub App installation access is revoked or becomes invalid:

1. The control plane marks the integration `degraded`.
2. Workspace and issue creation redirect back to `/setup/github-app`.
3. Use `Reconnect installation` to reinstall the existing app, or `Run setup again` to recreate the bootstrap flow.
4. Existing workspace metadata remains in PostgreSQL so the operator can recover without rebuilding the control plane.

## 8. Operational notes

- The compose sample is intended for self-hosted single-host operation.
- Mounting `docker.sock` gives the control plane privileged access to the host Docker daemon.
- `CONTROL_PLANE_RUNTIME_URL` must be reachable from worker containers, not just from the operator browser.
- Keep GitHub linked-issue auto-close enabled; the implementation phase creates pull requests that rely on `Fixes #<issue-number>` for merge completion.
- Keep the project's built-in workflow automation enabled so closed issues advance into the completed project state.
- For internet-facing deployments, put a reverse proxy and TLS terminator in front of the app.
- The helper script at [scripts/github-app-installation-token.sh](/home/ubuntu/projects/github-symphony/scripts/github-app-installation-token.sh) is now optional and mostly useful for diagnostics.

## References

- GitHub App manifests: https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest
- GitHub App installation authentication: https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app-installation
