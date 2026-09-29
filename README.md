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
  docker/     compose de desarrollo y del server, Dockerfile de la API, bootstrap de roles de Postgres
scripts/      deploy, prueba de humo y utilidades
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

## Despliegue en el server de demo

API + Postgres en Docker Compose, sobre el servidor Ubuntu compartido. Todo
lo que se crea lleva el prefijo `orquestacion` (proyecto de Compose, red,
volumen, contenedores) y tiene límite de memoria: en ese server corren otros
proyectos que no hay que tocar. `web`, `worker` y MinIO no se despliegan
todavía (ver `docs/phase-2-brief.md`).

| Pieza | Dónde |
| --- | --- |
| Imagen de la API (también corre migraciones y scripts) | `infra/docker/api.Dockerfile` |
| Compose del server | `infra/docker/compose.server.yml` |
| Variables del server | `infra/docker/.env` (no versionado; plantilla en `server.env.example`) |
| Deploy | `scripts/deploy.sh` |
| Compose con todo ya fijado | `scripts/compose.sh` |
| Prueba de humo | `scripts/smoke-test.sh` |

### Primera vez

Clonar `main` (el deploy no acepta otra rama). En el server (`ssh lomaro@192.168.0.105`), dentro del clon del repo:

```bash
git clone https://github.com/omarlpizarro/orquestacion.git ~/orquestacion
cd ~/orquestacion
cp infra/docker/server.env.example infra/docker/.env
# Reemplazá cada CHANGE_ME por `openssl rand -hex 24`.
$EDITOR infra/docker/.env
scripts/deploy.sh
```

Los roles de Postgres (`app_owner`, `app_login`) se crean una sola vez, al
inicializar el volumen, con los passwords que haya en `.env` en ese momento.
Cambiar un password después en `.env` no cambia el de la base: hay que
cambiarlo con `ALTER ROLE` o recrear el volumen.

### Cada deploy

```bash
cd ~/orquestacion
scripts/deploy.sh
```

Hace, en este orden y cortando en el primer error:

1. `git pull --ff-only`.
2. Imagen de la API, etiquetada con el commit: se construye, o se reutiliza si
   ya existe una con ese tag.
3. Postgres arriba (prerrequisito de migrar, no un reinicio).
4. **Migraciones** como paso explícito, en un contenedor efímero con las
   credenciales de `app_owner`. La API nunca las recibe ni migra al arrancar
   (regla de despliegues separados, `CLAUDE.md` sección 6).
5. Reinicio de la API y espera a que quede `healthy`.

Al final compara el commit que devuelve `/health` con el desplegado y, solo si
salió todo bien, borra imágenes viejas (ver más abajo). Si una migración falla,
la API vieja sigue corriendo.

**El server solo corre lo que está mergeado a `main`.** La regla es que el
commit a desplegar sea ancestro de `origin/main` (`git merge-base --is-ancestor`):
`origin/main` misma, o cualquier versión anterior. `deploy.sh` se niega si no
lo es, si el árbol está sucio, si el pull no se hace desde `main` o si `main`
local tiene commits que no están en `origin/main`; no hay flag para saltearlo.
También se niega con algún `CHANGE_ME` en `.env`, o si el puerto de la API lo
usa otro proceso.

Las decisiones detrás de este mecanismo (Compose a mano en vez de Coolify,
build en el servidor, migraciones como contenedor efímero, HTTP en la LAN) y
qué las cambiaría están en [ADR-014](./docs/adr/014-despliegue-en-servidor-de-demo.md).

Las migraciones que tienen `NOT VALID`/`VALIDATE` van en despliegues
separados (`CLAUDE.md` sección 6): no agrupes las dos en un mismo `deploy.sh`.

### Volver a una versión anterior

```bash
cd ~/orquestacion
git fetch && git log --oneline -15 origin/main   # elegí el commit destino
docker image ls orquestacion-api                  # ¿su imagen sigue ahí?
scripts/deploy.sh --to <commit>
scripts/smoke-test.sh
```

`--to` verifica que el commit sea ancestro de `origin/main` (y que sea
posterior al mecanismo de despliegue), hace el checkout desacoplado y despliega
con los mismos pasos de siempre. Si la imagen de ese commit sigue entre las
últimas tres no se reconstruye: la vuelta atrás es solo reinicio. Por qué
`--to` y no `git checkout <commit>` a mano: eso ejecutaría el `deploy.sh` *de
ese commit viejo*, que puede tener reglas más estrictas y negarse.

Qué hay que saber antes de usarlo:

- **Las migraciones no se revierten.** La base queda como está; el código
  viejo corre contra el esquema nuevo. Es seguro porque `CLAUDE.md` sección 6
  exige que las migraciones solo agreguen y no rompan lo que usa el código
  anterior. `deploy.sh` avisa cuando la base tiene más migraciones de las que
  conoce ese commit; ese aviso es el momento de confirmar que las
  intermedias cumplen esa regla. El migrador de Drizzle solo aplica lo
  posterior a la última migración registrada
  (`drizzle-orm/pg-core/dialect.js:60`), así que con un commit viejo no hace
  nada.
- El server queda en `HEAD` desacoplado en ese commit. **Para volver
  adelante:** `git checkout main && scripts/deploy.sh`. El deploy normal se
  niega desde un HEAD desacoplado.
- Los commits anteriores al primero que trae `infra/docker/compose.server.yml`
  no se pueden desplegar: `--to` se niega.

### Imágenes

Cada deploy exitoso conserva las 3 imágenes más recientes de
`orquestacion-api` (más la desplegada, si es una más vieja tras una vuelta
atrás) y borra el resto. Solo toca ese repositorio: en el server hay imágenes
de otros proyectos, y no se corre `docker image prune` ni `docker builder
prune` porque son globales. Un despliegue que falla no borra nada, porque las
imágenes anteriores son justo las que hacen falta para volver.

### Puertos y aislamiento

- La API se publica en el puerto `API_HOST_PORT` (por defecto `18020`).
  Verificado libre el 2026-09-29; ocupados por otros proyectos: 22, 1433,
  3000, 5432, 6333, 6334, 6379, 8000, 8080, 18000 y 18010.
- **Postgres no publica ningún puerto.** Solo es alcanzable desde la red
  interna de Compose. Para entrar: `scripts/compose.sh exec postgres psql -U postgres -d orquestacion`.
- Límites: 512 MB la API y Postgres, 256 MB las migraciones. Logs rotados
  (3 archivos de 10 MB).

### Correr un script operativo

Los scripts se corren en un contenedor efímero de la misma imagen, con el
mismo entorno y límites que la API, sin publicar puertos:

```bash
scripts/compose.sh run --rm --no-deps api node dist/src/scripts/ensure-default-sites.js
```

Es el mecanismo para cualquier script operativo futuro: el JS compilado vive
en `apps/api/dist/src/scripts/`, y se ejecuta con `node` desde el directorio de
trabajo de la imagen (`/repo/apps/api`). Corren como `app_login`, nunca como
`app_owner`.

### Cookies y TLS

Better Auth decide el atributo `Secure` de las cookies de sesión así
(`better-auth@1.7.5`, `dist/cookies/index.mjs:23`): si la opción
`advanced.useSecureCookies` está definida, manda esa; si no, y `baseURL` es un
string (nuestro caso, viene de `BETTER_AUTH_URL`), es `Secure` si y solo si
`BETTER_AUTH_URL` empieza con `https://`. `NODE_ENV=production` **no** cambia
eso: solo cuenta cuando no hay `baseURL`, y acá siempre lo hay.

Consecuencia: con `BETTER_AUTH_URL=http://192.168.0.105:18020` las cookies salen
sin `Secure` y la sesión persiste sin TLS. Con `https://` salen con `Secure` (y
con el prefijo `__Secure-`), y desde ese momento **exigen TLS de punta a
punta**: si la API quedara detrás de un proxy que termina TLS, la URL pública
tiene que seguir siendo `https://`. El error inverso —`https://` en la variable
pero acceso por http— es el que hace que el login parezca andar y la sesión no
persista. La prueba de humo lo detecta (paso 3).

Por eso esta pasada **no necesita TLS**: se prueba con `http://` y es seguro
mientras el server esté en la LAN. Se necesita TLS antes de exponerlo fuera de
la red interna o de usar un navegador contra un dominio real.

### Prueba de humo

```bash
scripts/smoke-test.sh
```

Verifica: `/health` (conecta como `app_login`, devuelve el commit desplegado),
Postgres sin puerto publicado, cuenta de humo con cookies coherentes con el
esquema de `BETTER_AUTH_URL` y sesión que persiste, organización de humo con
sitio por defecto (ADR-013) y `ensure-default-sites` corriendo dentro del
contenedor.

Es idempotente: usa siempre la cuenta `smoke@orquestacion.test` y la
organización con slug `smoke`. Si existen, inicia sesión y las reutiliza; si
no, las crea. El password de la cuenta es `SMOKE_PASSWORD` en
`infra/docker/.env`; si falta, la primera corrida lo genera y lo agrega.

## Flujo de trabajo

1. Rama por tarea desde `main`.
2. Pull request con `pnpm check && pnpm test` en verde (CI corre además
   `pnpm test:integration` y una verificación completa en Windows).
3. Merge a `main`.
4. Deploy en el servidor Ubuntu de test: `scripts/deploy.sh` (ver arriba).

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
