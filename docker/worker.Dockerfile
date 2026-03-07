FROM node:24-bookworm-slim AS build

WORKDIR /app

COPY tsconfig.base.json /app/tsconfig.base.json
COPY packages/worker/package.json /app/packages/worker/package.json
COPY packages/worker/tsconfig.json /app/packages/worker/tsconfig.json
COPY packages/worker/src /app/packages/worker/src

RUN npm install --no-save typescript@5.9.3 @types/node@24.12.0
RUN npx tsc -p /app/packages/worker/tsconfig.json

FROM node:24-bookworm-slim

WORKDIR /app

COPY --from=build /app/packages/worker/dist /app/dist
COPY packages/worker/package.json /app/package.json

ENV NODE_ENV=production
ENV PORT=4141
ENV WORKSPACE_RUNTIME_DIR=/workspace-runtime

EXPOSE 4141

CMD ["node", "dist/index.js"]
