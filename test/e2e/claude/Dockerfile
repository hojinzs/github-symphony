FROM node:24-bookworm-slim

WORKDIR /app

COPY . /app

RUN apt-get update && \
    apt-get install -y --no-install-recommends git bash && \
    rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@9.15.9 --activate
RUN pnpm install --frozen-lockfile
RUN pnpm build

ENV NODE_ENV=test

CMD ["pnpm", "exec", "vitest", "run", "--config", "test/e2e/claude/vitest.config.ts"]
