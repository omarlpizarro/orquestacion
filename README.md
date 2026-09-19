# Orquestación de Procesos

SaaS multi-tenant de orquestación de procesos y gestión ejecutiva para
gastronomía, agroindustria, salud, minería, energía, construcción y eventos.

**Estado:** definición de arquitectura terminada, desarrollo sin iniciar.

## Documentación

| Archivo | Qué contiene |
| --- | --- |
| [`CLAUDE.md`](./CLAUDE.md) | Reglas de trabajo obligatorias. Leer antes de escribir código |
| [`docs/requirements.md`](./docs/requirements.md) | Relevamiento funcional (RF-A1 a RF-F3, RNF) |
| [`docs/data-model.md`](./docs/data-model.md) | Esquema de base de datos, RLS, sincronización offline |
| [`docs/adr/`](./docs/adr/) | Decisiones de arquitectura, una por archivo |

## Stack

TypeScript en todas las capas. NestJS con Fastify, PostgreSQL 17 con Drizzle,
Better Auth, pg-boss, PowerSync, Next.js y Expo. Detalle y motivos en
`CLAUDE.md` sección 3.

## Estructura prevista

```
apps/
  api/        NestJS
  web/        Next.js
  mobile/     Expo
  worker/     procesos pg-boss
packages/
  contracts/  esquemas Zod + contratos ts-rest
  db/         esquema Drizzle y migraciones
  config/     tsconfig, biome, variables de entorno
infra/
  docker/
  powersync/
docs/
```

## Entorno de desarrollo

> Pendiente. Se completa al crear el esqueleto del monorepo.

Requisitos previstos: Node LTS (ver `.nvmrc`), pnpm, Docker y Docker Compose.

```bash
pnpm install
cp .env.example .env
docker compose -f infra/docker/compose.dev.yml up -d
pnpm db:migrate
pnpm dev
```

## Flujo de trabajo

1. Rama por tarea desde `main`.
2. Pull request con `pnpm check && pnpm test` en verde.
3. Merge a `main`.
4. Pull en el servidor Ubuntu de test.

`main` está protegida. Nada entra sin PR.

## Orden de construcción

1. Esqueleto, CI, deploy, auth y tenancy.
2. Proyectos, tareas, asignación, estados, "Mi Día", notificaciones, audit trail.
3. Recursos, reservas, plantillas SOP, campos personalizados.
4. Offline con PowerSync.
5. Dependencias, hitos, reprogramación en cascada.
6. Analytics y exportación.
7. Facturación y onboarding.
