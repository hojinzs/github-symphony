# ── Build stage ────────────────────────────────────────────────
FROM node:24-bookworm-slim AS build

WORKDIR /app
COPY . /app

RUN corepack enable && corepack prepare pnpm@9 --activate
RUN pnpm install --frozen-lockfile
RUN pnpm build

# Compile stub worker (standalone script, no monorepo deps)
RUN npx tsc e2e/stub-worker.ts \
    --outDir /app/e2e-compiled \
    --target ES2022 \
    --module nodenext \
    --moduleResolution nodenext \
    --skipLibCheck

# ── Runtime stage ─────────────────────────────────────────────
FROM node:24-bookworm-slim

RUN apt-get update && \
    apt-get install -y --no-install-recommends git curl jq openssl procps && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy built monorepo (packages + node_modules)
COPY --from=build --chown=node:node /app/packages /app/packages
COPY --from=build --chown=node:node /app/node_modules /app/node_modules
COPY --from=build --chown=node:node /app/package.json /app/package.json

# C23 production fleet CLI/HTTPS assembly and isolated OS-command peer.
COPY --from=build --chown=node:node /app/e2e/fleet-listener-e2e.mjs /app/e2e/fleet-listener-e2e.mjs
COPY --from=build --chown=node:node /app/e2e/fleet-listener-mutations.mjs /app/e2e/fleet-listener-mutations.mjs
COPY --from=build --chown=node:node /app/e2e/fleet-listener-os-peer.mjs /app/e2e/fleet-listener-os-peer.mjs

# Copy compiled stub worker
COPY --from=build --chown=node:node /app/e2e-compiled/stub-worker.js /app/e2e/stub-worker.js
COPY --from=build --chown=node:node /app/e2e/host-dynamic-tool-e2e.mjs /app/e2e/host-dynamic-tool-e2e.mjs
COPY --from=build --chown=node:node /app/e2e/fleet-enrollment-server.mjs /app/e2e/fleet-enrollment-server.mjs
COPY --from=build --chown=node:node /app/e2e/fleet-enrollment-e2e.mjs /app/e2e/fleet-enrollment-e2e.mjs
COPY --from=build --chown=node:node /app/e2e/fleet-enrollment-mutations.mjs /app/e2e/fleet-enrollment-mutations.mjs
COPY --from=build --chown=node:node /app/e2e/expected-target-stop.mjs /app/e2e/expected-target-stop.mjs
COPY --from=build --chown=node:node /app/e2e/management-agent-contract.mjs /app/e2e/management-agent-contract.mjs

COPY --from=build --chown=node:node /app/e2e/bounded-read-contract.mjs /app/e2e/bounded-read-contract.mjs

COPY --from=build --chown=node:node /app/e2e/agent-transport-e2e.mjs /app/e2e/agent-transport-e2e.mjs

# OTLP lifecycle contract uses built service/providers, not Vitest mocks.
COPY --from=build --chown=node:node /app/e2e/otlp-lifecycle-contract.mjs /app/e2e/otlp-lifecycle-contract.mjs
COPY --from=build --chown=node:node /app/e2e/fleet-commands-peer.mjs /app/e2e/fleet-commands-peer.mjs
COPY --from=build --chown=node:node /app/e2e/fleet-commands-e2e.mjs /app/e2e/fleet-commands-e2e.mjs
COPY --from=build --chown=node:node /app/e2e/fleet-commands-mutations.mjs /app/e2e/fleet-commands-mutations.mjs
COPY --from=build --chown=node:node /app/e2e/agent-executor-e2e.mjs /app/e2e/agent-executor-e2e.mjs
COPY --from=build --chown=node:node /app/e2e/agent-executor-mutations.mjs /app/e2e/agent-executor-mutations.mjs

COPY --from=build --chown=node:node /app/e2e/fleet-observations-e2e.mjs /app/e2e/fleet-observations-e2e.mjs
COPY --from=build --chown=node:node /app/e2e/fleet-observations-mutations.mjs /app/e2e/fleet-observations-mutations.mjs

COPY --from=build --chown=node:node /app/e2e/fleet-reads-e2e.mjs /app/e2e/fleet-reads-e2e.mjs
COPY --from=build --chown=node:node /app/e2e/fleet-reads-mutations.mjs /app/e2e/fleet-reads-mutations.mjs

COPY --from=build --chown=node:node /app/e2e/linux-agent-service-e2e.mjs /app/e2e/linux-agent-service-e2e.mjs
COPY --from=build --chown=node:node /app/e2e/run-linux-agent-service-probes.mjs /app/e2e/run-linux-agent-service-probes.mjs

COPY --from=build --chown=node:node /app/e2e/lib/json-journal.mjs /app/e2e/lib/json-journal.mjs
COPY --from=build --chown=node:node /app/e2e/lib/json-journal.test.mjs /app/e2e/lib/json-journal.test.mjs

COPY --from=build --chown=node:node /app/e2e/fleet-projects-e2e.mjs /app/e2e/fleet-projects-e2e.mjs
COPY --from=build --chown=node:node /app/e2e/fleet-projects-mutations.mjs /app/e2e/fleet-projects-mutations.mjs

COPY --from=build --chown=node:node /app/e2e/fleet-command-ui-harness.mjs /app/e2e/fleet-command-ui-harness.mjs
COPY --from=build --chown=node:node /app/e2e/fleet-command-ui-e2e.mjs /app/e2e/fleet-command-ui-e2e.mjs
COPY --from=build --chown=node:node /app/e2e/fleet-command-ui-mutations.mjs /app/e2e/fleet-command-ui-mutations.mjs
COPY --from=build --chown=node:node /app/e2e/fleet-command-ui-browser.mjs /app/e2e/fleet-command-ui-browser.mjs

COPY --from=build --chown=node:node /app/e2e/agent-setup-e2e.mjs /app/e2e/agent-setup-e2e.mjs
COPY --from=build --chown=node:node /app/e2e/agent-setup-probes.mjs /app/e2e/agent-setup-probes.mjs

COPY --from=build --chown=node:node /app/e2e/fleet-runs-fixture.mjs /app/e2e/fleet-runs-fixture.mjs
COPY --from=build --chown=node:node /app/e2e/fleet-runs-e2e.mjs /app/e2e/fleet-runs-e2e.mjs
COPY --from=build --chown=node:node /app/e2e/fleet-runs-browser.mjs /app/e2e/fleet-runs-browser.mjs
COPY --from=build --chown=node:node /app/e2e/fleet-runs-mutations.mjs /app/e2e/fleet-runs-mutations.mjs

# Copy seed data
# C15 environment connection UI protocol and browser fixtures.
COPY --from=build --chown=node:node /app/e2e/fleet-environments-harness.mjs /app/e2e/fleet-environments-harness.mjs
COPY --from=build --chown=node:node /app/e2e/fleet-environments-e2e.mjs /app/e2e/fleet-environments-e2e.mjs
COPY --from=build --chown=node:node /app/e2e/fleet-environments-mutations.mjs /app/e2e/fleet-environments-mutations.mjs
COPY --from=build --chown=node:node /app/e2e/fleet-environments-browser.mjs /app/e2e/fleet-environments-browser.mjs

COPY --chown=node:node e2e/seed /e2e/seed

# Initialize bare git repo for E2E
RUN bash /e2e/seed/init-repo.sh

# Ensure fixtures directory exists
RUN mkdir -p /e2e/fixtures /e2e/workspaces /e2e/evidence /e2e/repos && \
    chown -R node:node /e2e/fixtures /e2e/workspaces /e2e/evidence /e2e/repos

USER node

ENV NODE_ENV=production
ENV SYMPHONY_WORKER_COMMAND="node /app/e2e/stub-worker.js"

EXPOSE 4680
