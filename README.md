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

API + worker + web + Postgres en Docker Compose, sobre el servidor Ubuntu compartido. Todo
lo que se crea lleva el prefijo `orquestacion` (proyecto de Compose, red,
volumen, contenedores) y tiene límite de memoria: en ese server corren otros
proyectos que no hay que tocar. MinIO no se despliega todavía (ver
`docs/phase-2-brief.md`). La `web` (Next.js, ADR-020) sí, desde su shell: es el único
origen que ve el navegador y reescribe `/api/auth/*` y `/backend/*` hacia la API por la red
interna. El `worker` (pg-boss) sí, desde ADR-018: mantiene
las particiones mensuales de `audit_log` (ADR-018) y procesa la bandeja de avisos
(`notification_outbox`, ADR-019). Misma imagen que la API,
conecta como `app_worker` y no publica puertos. Para ver que anda:
`scripts/verify-audit-worker.sh` y `scripts/verify-notification-outbox.sh` (solo
lectura); la prueba de humo los chequea en sus pasos 7 y 8.

| Pieza | Dónde |
| --- | --- |
| Imagen de la API (también corre migraciones y scripts) | `infra/docker/api.Dockerfile` |
| Imagen de la web | `infra/docker/web.Dockerfile` |
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
# Reemplazá cada CHANGE_ME por `openssl rand -hex 32`.
$EDITOR infra/docker/.env
scripts/deploy.sh
```

Los roles de Postgres (`app_owner`, `app_login`, `app_worker`,
`app_rls_helper`) los crea `packages/db/sql/ensure-roles.sql` al inicializar el
volumen, con los passwords que haya en `.env` en ese momento. Cambiar un
password después en `.env` no cambia el de la base: hay que cambiarlo con
`ALTER ROLE` o recrear el volumen.

### Roles de Postgres en un ambiente que ya existe

El script de inicio de Postgres solo corre con el volumen vacío, así que en un
server que ya tiene datos los roles nuevos (`app_worker` y `app_rls_helper`,
ADR-017) no se crean solos. `ensure-roles.sql` es idempotente y se corre **una
vez, a mano, antes del `deploy.sh` que trae las migraciones que dependen de
ellos** (la migración falla con un mensaje claro si no los encuentra):

```bash
cd ~/orquestacion
git pull --ff-only                       # trae ensure-roles.sql al bind mount /bootstrap-sql
$EDITOR infra/docker/.env                # agregá APP_WORKER_PASSWORD=<openssl rand -hex 32>
set -a; . infra/docker/.env; set +a      # las contraseñas quedan en el entorno del shell
scripts/compose.sh exec -T   -e APP_OWNER_PASSWORD -e APP_LOGIN_PASSWORD -e APP_WORKER_PASSWORD   postgres psql -v ON_ERROR_STOP=1 -U postgres -d orquestacion   -f /bootstrap-sql/ensure-roles.sql
```

`-e NOMBRE` sin `=valor` copia la variable del entorno del shell al proceso: la
contraseña no aparece en la línea de comando ni en `ps`. `ensure-roles.sql` la
lee con `getenv`; no cambia la contraseña de un rol que ya existe y vuelve a
afirmar los atributos de cada uno. Termina con una verificación que aborta si
`app_rls_helper` tiene alguna membresía o si algún otro rol no superusuario tiene
`BYPASSRLS`. Se puede repetir sin riesgo.

### Cada deploy

```bash
cd ~/orquestacion
scripts/deploy.sh
```

Hace, en este orden y cortando en el primer error:

1. `git pull --ff-only`.
2. Imágenes de la API y de la web, etiquetadas con el commit: se construyen, o se
   reutilizan si ya existe una con ese tag.
3. Postgres arriba (prerrequisito de migrar, no un reinicio).
4. **Migraciones** como paso explícito, en un contenedor efímero con las
   credenciales de `app_owner`. La API nunca las recibe ni migra al arrancar
   (regla de despliegues separados, `CLAUDE.md` sección 6).
5. Reinicio de la API y espera a que quede `healthy`.
6. Reinicio del worker.
7. Reinicio de la web, que depende de la API sana.

Al final compara el commit que devuelven `/health` (API) y `/healthz` (web) con el desplegado y, solo si
salió todo bien, borra imágenes viejas (ver más abajo). Si una migración falla,
la API vieja sigue corriendo.

**El server solo corre lo que está mergeado a `main`.** La regla es que el
commit a desplegar sea ancestro de `origin/main` (`git merge-base --is-ancestor`):
`origin/main` misma, o cualquier versión anterior. `deploy.sh` se niega si no
lo es, si el árbol está sucio, si el pull no se hace desde `main` o si `main`
local tiene commits que no están en `origin/main`; no hay flag para saltearlo.
También se niega con algún `CHANGE_ME` en `.env`, con `APP_WORKER_PASSWORD` vacía o ausente, si el puerto de la API o el de la web lo
usa otro proceso, o si `BETTER_AUTH_URL` sigue apuntando al puerto de la API (desde ADR-020 es el
origen de la web).

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
`orquestacion-api` y de `orquestacion-web` (más la desplegada, si es una más vieja tras una vuelta
atrás) y borra el resto. Solo toca esos dos repositorios: en el server hay imágenes
de otros proyectos, y no se corre `docker image prune` ni `docker builder
prune` porque son globales. Un despliegue que falla no borra nada, porque las
imágenes anteriores son justo las que hacen falta para volver.

### Puertos y aislamiento

- La API se publica en el puerto `API_HOST_PORT` (por defecto `18020`) y la web en
  `WEB_HOST_PORT` (por defecto `18030`; `deploy.sh` lo chequea antes de levantar). Los dos
  puertos son del host; el navegador usa el de la web.
  Verificado libre el 2026-09-29; ocupados por otros proyectos: 22, 1433,
  3000, 5432, 6333, 6334, 6379, 8000, 8080, 18000 y 18010.
- **Postgres no publica ningún puerto.** Solo es alcanzable desde la red
  interna de Compose. Para entrar: `scripts/compose.sh exec postgres psql -U postgres -d orquestacion`.
- Límites: 512 MB la API y Postgres, 256 MB la web (medido en la imagen real: ~58 MiB tras
  40 pedidos), el worker y las migraciones. Logs rotados
  (3 archivos de 10 MB).

### Correr un script operativo

Los scripts se corren en un contenedor efímero de la misma imagen, sin
publicar puertos, en el servicio `scripts` de Compose (perfil `ops`, igual que
`migrate`):

```bash
scripts/compose.sh run --rm --no-deps scripts node dist/src/scripts/ensure-default-sites.js
```

Es el mecanismo para cualquier script operativo futuro: el JS compilado vive
en `apps/api/dist/src/scripts/`, y se ejecuta con `node` desde el directorio de
trabajo de la imagen (`/repo/apps/api`). Corren como `app_worker` (ADR-017 §5),
nunca como `app_owner` ni como `app_login`: el servicio `scripts` recibe
`DATABASE_WORKER_URL` y la API no, porque con el password de `app_worker` la API
podría declararse "sistema" en las policies. Un script nuevo lee su conexión con
`loadWorkerEnv()`.

### Cookies y TLS

Better Auth decide el atributo `Secure` de las cookies de sesión así
(`better-auth@1.7.5`, `dist/cookies/index.mjs:23`): si la opción
`advanced.useSecureCookies` está definida, manda esa; si no, y `baseURL` es un
string (nuestro caso, viene de `BETTER_AUTH_URL`), es `Secure` si y solo si
`BETTER_AUTH_URL` empieza con `https://`. `NODE_ENV=production` **no** cambia
eso: solo cuenta cuando no hay `baseURL`, y acá siempre lo hay.

Desde ADR-020 `BETTER_AUTH_URL` es el **origen de la web** (el navegador solo habla con ese
origen; la API nunca se ve desde afuera salvo el móvil, que le habla directo).
Consecuencia: con `BETTER_AUTH_URL=http://192.168.0.105:18030` las cookies salen
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
sitio por defecto (ADR-013), `ensure-default-sites` corriendo dentro del
contenedor y, en el paso 9, la web: `/healthz` con el commit, redirección a `/login` sin sesión,
inicio de sesión y sesión por el proxy mismo-origen, página protegida con organización activa
y `/backend/*` llegando a la API.

Es idempotente: usa siempre la cuenta `smoke@orquestacion.test` y la
organización con slug `smoke`. Si existen, inicia sesión y las reutiliza; si
no, las crea. El password de la cuenta es `SMOKE_PASSWORD` en
`infra/docker/.env`; si falta, la primera corrida lo genera y lo agrega.

### Datos de demo

`scripts/seed-demo.sh --demo` crea una organización de demo ("Constructora Demo") para poder mostrar el
producto: una dueña, un gerente y un operario (las tres cuentas con la misma contraseña, `DEMO_PASSWORD`,
que se genera en la primera corrida y queda en `infra/docker/.env`), un proyecto abierto al sitio con
tareas en todos los estados, y uno reservado para mostrar la visibilidad. **Solo para el servidor de demo,
nunca para un ambiente con datos de un cliente**: sin `--demo` se niega. Lo corre Omar a mano, porque
escribe en la base.

Es idempotente (ids y `client_mutation_id` fijos): correrlo de nuevo no duplica nada y retoma donde se cortó.
Las fechas planificadas son relativas al día de la primera corrida; para una demo con fechas frescas hay que
empezar de cero. Crea todo por la API (cuentas, organización, invitaciones aceptadas, proyectos, tareas,
estados, comentarios), de modo que corren los mismos hooks, reglas de RLS y avisos que en producción. No escribe
nada por fuera de la API: la organización no tiene `organization_profile` (el rubro es un dato del onboarding,
fase 7) y "Mi Día" usa la zona de su sitio por defecto (aclaración en ADR-013).

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
