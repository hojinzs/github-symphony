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
    apt-get install -y --no-install-recommends git curl && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy built monorepo (packages + node_modules)
COPY --from=build --chown=node:node /app/packages /app/packages
COPY --from=build --chown=node:node /app/node_modules /app/node_modules
COPY --from=build --chown=node:node /app/package.json /app/package.json

# Copy compiled stub worker
COPY --from=build --chown=node:node /app/e2e-compiled/stub-worker.js /app/e2e/stub-worker.js

# Copy seed data
COPY --chown=node:node e2e/seed /e2e/seed

# Initialize bare git repo for E2E
RUN bash /e2e/seed/init-repo.sh

# Prepare entrypoint
COPY --chown=node:node e2e/seed/entrypoint.sh /e2e/entrypoint.sh
RUN chmod +x /e2e/entrypoint.sh

# Ensure fixtures directory exists
RUN mkdir -p /e2e/fixtures /e2e/workspaces /e2e/evidence && \
    chown -R node:node /e2e/fixtures /e2e/workspaces /e2e/evidence /e2e/repos

USER node

ENV NODE_ENV=production
ENV SYMPHONY_WORKER_COMMAND="node /app/e2e/stub-worker.js"

EXPOSE 4680

ENTRYPOINT ["/e2e/entrypoint.sh"]
