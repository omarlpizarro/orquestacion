# syntax=docker/dockerfile:1
#
# Imagen de la API. Contexto de build: la raíz del repo (lo fija compose).
# La misma imagen sirve para correr la API, las migraciones y los scripts
# operativos: cambia el comando, no la imagen (ver compose.server.yml).

ARG NODE_VERSION=24.16.0

FROM node:${NODE_VERSION}-bookworm-slim AS base
# La versión de pnpm sale de `packageManager` en package.json.
RUN corepack enable
WORKDIR /repo

# Solo los manifiestos: mientras no cambien, la capa de instalación queda en
# caché aunque cambie el código fuente.
FROM base AS manifests
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/api/package.json apps/api/
COPY packages/config/package.json packages/config/
COPY packages/contracts/package.json packages/contracts/
COPY packages/db/package.json packages/db/

FROM manifests AS build
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --filter "@orq/api..."
COPY tsconfig.json ./
COPY packages/config packages/config
COPY packages/contracts packages/contracts
COPY packages/db packages/db
COPY apps/api apps/api
# `...` construye primero las dependencias de workspace (config, contracts, db).
RUN pnpm --filter "@orq/api..." build

FROM manifests AS runtime
ENV NODE_ENV=production
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --prod --filter "@orq/api..."
COPY --from=build /repo/packages/config/dist packages/config/dist
COPY --from=build /repo/packages/contracts/dist packages/contracts/dist
COPY --from=build /repo/packages/db/dist packages/db/dist
COPY --from=build /repo/packages/db/migrations packages/db/migrations
COPY --from=build /repo/apps/api/dist apps/api/dist

# Al final a propósito: el commit cambia en cada deploy, y ponerlo antes
# invalidaría el caché de todo lo de arriba.
ARG GIT_COMMIT=unknown
ENV GIT_COMMIT=${GIT_COMMIT}

USER node
WORKDIR /repo/apps/api
# `nest build` emite en dist/src (rootDir "." en tsconfig.json), no en dist.
CMD ["node", "dist/src/main.js"]
