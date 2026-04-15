ARG NODE_IMAGE=node:24-bookworm-slim
ARG PNPM_VERSION=9.15.9

FROM ${NODE_IMAGE} AS pack

ARG PNPM_VERSION

WORKDIR /src

COPY . .

RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate
RUN pnpm install --frozen-lockfile
RUN pnpm build
RUN mkdir -p /tmp/gh-symphony-dist
RUN cd packages/cli && npm pack --pack-destination /tmp/gh-symphony-dist

FROM ${NODE_IMAGE}

ARG GH_SYMPHONY_INSTALL_SOURCE=registry
ARG GH_SYMPHONY_VERSION=latest

ENV NODE_ENV=production
ENV GH_SYMPHONY_CONFIG_DIR=/var/lib/gh-symphony

RUN apt-get update && \
    apt-get install -y --no-install-recommends ca-certificates git openssh-client tini && \
    rm -rf /var/lib/apt/lists/*

COPY --from=pack /tmp/gh-symphony-dist /tmp/gh-symphony-dist

RUN set -eux; \
    if [ "${GH_SYMPHONY_INSTALL_SOURCE}" = "local" ]; then \
      pkg="$(find /tmp/gh-symphony-dist -maxdepth 1 -name '*.tgz' -print -quit)"; \
      test -n "${pkg}"; \
      npm install -g "${pkg}"; \
    else \
      npm install -g "@gh-symphony/cli@${GH_SYMPHONY_VERSION}"; \
    fi; \
    npm cache clean --force; \
    rm -rf /tmp/gh-symphony-dist

WORKDIR /workspace
VOLUME ["/var/lib/gh-symphony"]

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["gh-symphony", "start"]
