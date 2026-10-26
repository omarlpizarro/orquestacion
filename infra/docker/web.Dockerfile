# syntax=docker/dockerfile:1
#
# Imagen de la web (Next.js, salida `standalone`). Contexto de build: la raíz del repo
# (lo fija compose). Imagen aparte de la API a propósito: la web no necesita pg ni Nest.

ARG NODE_VERSION=24.16.0

FROM node:${NODE_VERSION}-bookworm-slim AS base
RUN corepack enable
WORKDIR /repo

FROM base AS manifests
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/web/package.json apps/web/
COPY packages/config/package.json packages/config/
COPY packages/contracts/package.json packages/contracts/
COPY packages/ui-tokens/package.json packages/ui-tokens/

FROM manifests AS build
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --filter "@orq/web..."
COPY tsconfig.json ./
COPY packages/config packages/config
COPY packages/contracts packages/contracts
COPY packages/ui-tokens packages/ui-tokens
COPY apps/web apps/web
# `next.config.ts` graba el destino de los rewrites en el BUILD (ADR-020): la API se ve
# siempre como `api:3000` desde la red interna de Compose.
ARG API_URL=http://api:3000
ENV API_URL=${API_URL} NEXT_TELEMETRY_DISABLED=1
# `...` construye primero las dependencias de workspace (config, contracts, ui-tokens).
RUN pnpm --filter "@orq/web..." build

FROM base AS runtime
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
# `standalone` ya trae su propio node_modules mínimo; con la raíz de rastreo en la raíz del
# monorepo, el servidor queda en apps/web/server.js. Los estáticos no van dentro: se copian aparte.
COPY --from=build --chown=node:node /repo/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /repo/apps/web/.next/static apps/web/.next/static

# Al final a propósito: el commit cambia en cada deploy (ver api.Dockerfile).
ARG GIT_COMMIT=unknown
ENV GIT_COMMIT=${GIT_COMMIT}

USER node
WORKDIR /repo/apps/web
CMD ["node", "server.js"]
