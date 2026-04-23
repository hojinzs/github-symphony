ARG NODE_IMAGE=node:24-bookworm-slim
ARG PNPM_VERSION=9.15.9
ARG INSTALLER_STAGE=installer-registry

FROM ${NODE_IMAGE} AS pack

ARG PNPM_VERSION

WORKDIR /src

COPY . .

RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate
RUN pnpm install --frozen-lockfile
RUN pnpm build
RUN mkdir -p /tmp/gh-symphony-dist
RUN cd packages/cli && npm pack --pack-destination /tmp/gh-symphony-dist

FROM ${NODE_IMAGE} AS runtime-base

ARG GH_SYMPHONY_UID=1000
ARG GH_SYMPHONY_GID=1000

ENV NODE_ENV=production
ENV GH_SYMPHONY_CONFIG_DIR=/var/lib/gh-symphony

RUN apt-get update && \
    apt-get install -y --no-install-recommends ca-certificates git openssh-client tini && \
    existing_group="$(getent group "${GH_SYMPHONY_GID}" | cut -d: -f1 || true)" && \
    if [ -n "${existing_group}" ] && [ "${existing_group}" != "symphony" ]; then groupmod --new-name symphony "${existing_group}"; \
    elif [ -z "${existing_group}" ]; then groupadd --gid "${GH_SYMPHONY_GID}" symphony; fi && \
    existing_user="$(getent passwd "${GH_SYMPHONY_UID}" | cut -d: -f1 || true)" && \
    if [ -n "${existing_user}" ] && [ "${existing_user}" != "symphony" ]; then usermod --login symphony --home /home/symphony --move-home --gid "${GH_SYMPHONY_GID}" --shell /bin/bash "${existing_user}"; \
    elif [ -z "${existing_user}" ]; then useradd --uid "${GH_SYMPHONY_UID}" --gid "${GH_SYMPHONY_GID}" --create-home --shell /bin/bash symphony; fi && \
    mkdir -p /var/lib/gh-symphony /workspace && \
    chown -R symphony:symphony /var/lib/gh-symphony /workspace && \
    rm -rf /var/lib/apt/lists/*

FROM runtime-base AS installer-registry

ARG GH_SYMPHONY_VERSION=latest

RUN npm install -g "@gh-symphony/cli@${GH_SYMPHONY_VERSION}" && \
    npm cache clean --force

FROM runtime-base AS installer-local

COPY --from=pack /tmp/gh-symphony-dist /tmp/gh-symphony-dist

RUN set -eux; \
    pkg="$(find /tmp/gh-symphony-dist -maxdepth 1 -name '*.tgz' -print -quit)"; \
    test -n "${pkg}"; \
    npm install -g "${pkg}"; \
    npm cache clean --force; \
    rm -rf /tmp/gh-symphony-dist

ARG INSTALLER_STAGE
FROM ${INSTALLER_STAGE} AS final

WORKDIR /workspace
VOLUME ["/var/lib/gh-symphony"]
USER symphony

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["gh-symphony", "start"]
