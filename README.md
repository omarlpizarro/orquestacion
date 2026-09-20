# Orquestación de Procesos

SaaS multi-tenant de orquestación de procesos y gestión ejecutiva para
gastronomía, agroindustria, salud, minería, energía, construcción y eventos.

**Estado:** esqueleto del monorepo y CI andando. Auth, tenancy y deploy,
pendientes (fase 1 de `CLAUDE.md` sección 14).

## Documentación

| Archivo | Qué contiene |
| --- | --- |
| [`CLAUDE.md`](./CLAUDE.md) | Reglas de trabajo obligatorias. Leer antes de escribir código |
| [`docs/requirements.md`](./docs/requirements.md) | Relevamiento funcional (RF-A1 a RF-F3, RNF) |
| [`docs/data-model.md`](./docs/data-model.md) | Esquema de base de datos, RLS, sincronización offline |
| [`docs/adr/`](./docs/adr/) | Decisiones de arquitectura, una por archivo |

## Stack

TypeScript en todas las capas. NestJS 12 con Fastify, PostgreSQL 17 con
Drizzle, Zod + oRPC para contratos, pg-boss, PowerSync (más adelante),
Next.js y Expo (más adelante). Versiones exactas y motivos en `CLAUDE.md`
sección 3.

## Estructura

```
apps/
  api/        NestJS + Fastify
  web/        Next.js App Router
  worker/     procesos pg-boss
packages/
  contracts/  esquemas Zod + contratos oRPC. ESM puro
  db/         esquema Drizzle, migraciones, arnés de tests con Testcontainers
  config/     tsconfig, Biome, validación de variables de entorno
infra/
  docker/     compose de desarrollo, bootstrap de roles de Postgres
docs/
```

`apps/mobile` e `infra/powersync/` llegan en la fase 4 (offline), no antes.

## Entorno de desarrollo

Requisitos: Node 24.16.0 (ver `.nvmrc`), pnpm vía corepack, Docker Desktop.

```bash
corepack enable
pnpm install
cp .env.example .env
docker compose -f infra/docker/compose.dev.yml up -d
pnpm db:migrate
pnpm dev
```

`pnpm dev` levanta la API en `:3000` y el dashboard en `:3001` (puerto por
defecto de Next). `curl http://localhost:3000/health` tiene que devolver
`"connectedAs": "app_login"` — si devuelve otro rol, algo en `.env` apunta mal.

### Tests de integración (Testcontainers)

Requieren Docker corriendo. Bajan la imagen de Postgres la primera vez.

```bash
pnpm test:integration
```

**Windows:** correr desde PowerShell. Bajo Git Bash hace falta
`MSYS_NO_PATHCONV=1` antes del comando, porque MSYS traduce la ruta del
socket que Testcontainers monta para su contenedor de limpieza (Ryuk) y la
rompe.

## Flujo de trabajo

1. Rama por tarea desde `main`.
2. Pull request con `pnpm check && pnpm test` en verde (CI corre además
   `pnpm test:integration` y una verificación completa en Windows).
3. Merge a `main`.
4. Pull en el servidor Ubuntu de test.

`main` está protegida. Nada entra sin PR.

## Orden de construcción

1. Esqueleto, CI, deploy, auth y tenancy. **Esqueleto y CI: hecho.** Deploy,
   auth y tenancy: pendientes.
2. Proyectos, tareas, asignación, estados, "Mi Día", notificaciones, audit trail.
3. Recursos, reservas, plantillas SOP, campos personalizados.
4. Offline con PowerSync.
5. Dependencias, hitos, reprogramación en cascada.
6. Analytics y exportación.
7. Facturación y onboarding.
