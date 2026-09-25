# CLAUDE.md

Instrucciones obligatorias para trabajar en este repositorio. Se leen en cada
sesión. Si algo de este archivo contradice una sugerencia tuya, gana este archivo.

---

## 1. Qué es este proyecto

SaaS multi-tenant de orquestación de procesos y gestión ejecutiva. Conecta a la
alta dirección con la gerencia media y el personal operativo en sectores donde el
trabajo pasa hoy por cuadernos, llamadas y grupos de WhatsApp: gastronomía,
agroindustria, salud, minería, energía, construcción y eventos.

Tres superficies:

- **API** (`apps/api`): NestJS. Toda la lógica de negocio.
- **Dashboard web** (`apps/web`): Next.js. Niveles directivos y administración.
- **App móvil** (`apps/mobile`): Expo. Personal de campo, offline-first.

El relevamiento funcional completo está en `docs/requirements.md`. El esquema de
base de datos, en `docs/data-model.md`. **Leé `docs/data-model.md` antes de tocar
cualquier cosa relacionada con la base.**

---

## 2. Reglas duras

Estas no se negocian y no se preguntan. Violarlas es un bug, no una opción de diseño.

1. **Toda tabla de negocio lleva `organization_id`.** Sin excepciones, incluidas
   las tablas hijas donde parece redundante.
2. **Toda tabla con `organization_id` tiene RLS habilitada y forzada.** Si creás
   una tabla, creás su policy en la misma migración.
3. **Todo acceso a datos pasa por una transacción con el contexto seteado**
   (`app.current_org`, `app.current_member`, `app.request_id`). Nunca uses el
   cliente de base sin contexto, ni siquiera en un script.
4. **Nunca uses el rol de base dueño del esquema desde la aplicación.** La app
   se conecta como `app_login` (hereda los permisos de `app_user`, un rol de
   grupo `NOLOGIN`), ninguno de los dos con `BYPASSRLS`. Las migraciones corren
   como `app_owner`, que la aplicación nunca usa.
5. **Ningún módulo consulta tablas de otro módulo.** Se comunican por servicios
   exportados y eventos in-process. Ver sección 5.
6. **Los IDs son UUIDv7 generados en el cliente**, no `gen_random_uuid()` del lado
   servidor. El móvil offline necesita crear filas sin conexión.
7. **Ninguna migración hace `DROP COLUMN` en el mismo despliegue que deja de usar
   la columna.** Primero dejás de escribir, desplegás, verificás; el borrado va en
   un despliegue posterior.
8. **Nunca guardes binarios en Postgres.** Van al object storage; en la base queda
   la fila de `attachment` con su `storage_key`.
9. **Nunca borres físicamente datos de negocio.** `deleted_at`, siempre.
10. **No inventes tablas ni columnas.** Si el modelo de datos no cubre lo que
    necesitás, decilo y proponé el cambio; no lo agregues por tu cuenta.

---

## 3. Stack

No propongas alternativas a esta tabla por preferencia. Sí frená y planteá el caso cuando una elección esté bloqueada por un hecho verificable: un paquete sin mantenimiento, una incompatibilidad de versiones, una licencia que cambió. Adjuntá la evidencia.
Ejemplo: @ts-rest/nest (última estable 3.52.1, marzo 2025) declara peer @nestjs/core ^9||^10||^11 y zod ^3.22.3. NestJS ya va por la 12 y Zod por la 4.

| Capa | Herramienta | Versión exacta | Nota |
| --- | --- | --- | --- |
| Runtime | Node LTS | 24.16.0 | `.nvmrc` |
| Gestor de paquetes | pnpm (vía corepack) | 12.4.2 | |
| Lenguaje | TypeScript, `strict: true` | 6.0.3 | Sin `any` salvo en límites de terceros, con comentario. No 7.x: todavía no expone API de compilador, que `nest build` necesita |
| API | NestJS con adaptador Fastify | 12.0.3 | Módulos = fronteras del monolito modular. ESM puro (`"type": "module"`) |
| Base de datos | PostgreSQL 17 | — | Extensiones: `btree_gist`, `pg_trgm`, `pgcrypto`, `ltree` |
| Driver de Postgres | `pg` | 8.23.0 | No `postgres` (postgres.js): pg-boss ya depende de `pg`, dos drivers duplicarían pools |
| ORM | Drizzle | `drizzle-orm` 0.45.2, `drizzle-kit` 0.31.10 | SQL-first. Migraciones con `drizzle-kit`, incluidas las de SQL crudo (`generate --custom`) |
| Contratos | Zod 4 + oRPC | `zod` 4.6.5, `@orpc/*` 1.15.2 | Ver ADR-005. Fuente única en `packages/contracts`, ESM puro. **Es la v1 de oRPC: se usa `oc.route()`, no la sintaxis de `oc.meta(openapi(...))` que muestra orpc.dev (esa es v2, sin publicar en npm todavía)** |
| Fechas y zonas horarias | date-fns + date-fns-tz | `date-fns` 4.4.0, `date-fns-tz` 3.2.0 | Ver ADR-008. Node 24.16.0 no expone `Temporal` global todavía (verificado: `typeof Temporal === 'undefined'`), así que la conversión hora-local-del-sitio → UTC no se resuelve con nada nativo |
| Auth | Better Auth + plugin `organization` | `better-auth` 1.7.5, CLI `auth` 1.7.5 (devDependency, solo para `auth generate`) | Tablas generadas por su CLI, no se editan a mano. Viven en su propio esquema de Postgres `auth`, no en `public` (ADR-011). Sus IDs son `text` opaco, no `uuid` (ADR-010) |
| Jobs | pg-boss | 12.33.2 | Sobre el mismo Postgres. Encolado transaccional |
| Offline | PowerSync (Open Edition, self-hosted) | — | Bucket storage en Postgres separado |
| Móvil | Expo / React Native | — | SQLite vía PowerSync |
| Web | Next.js App Router | `next` 16.3.5, `react`/`react-dom` 19.3.0 | |
| PDF | Playwright renderizando una ruta de `apps/web` | — | Contenedor aparte |
| Excel | ExcelJS | — | |
| Storage | S3-compatible (MinIO en dev, R2 o MinIO en prod) | — | Presigned URLs |
| Lint y formato | Biome | 2.5.14 | Reemplaza ESLint y Prettier. `javascript.parser.unsafeParameterDecoratorsEnabled: true` para que parsee los decoradores de parámetro de Nest; `style.useImportType` apagada a propósito (ver `packages/config/biome/base.json`) |
| Tests | Vitest + Testcontainers | `vitest`/`@vitest/coverage-v8` 4.1.11, `testcontainers`/`@testcontainers/postgresql` 12.1.0 | Postgres real en integración, nunca mocks de base |
| Fronteras | dependency-cruiser | 18.3.1 | Falla el build si un módulo cruza. `tsPreCompilationDeps: true` es obligatorio o las reglas contra `import type` quedan mudas |
| Monorepo | Turborepo | 2.11.2 | |
| Infra | Docker Compose sobre Ubuntu LTS, gestionado con Coolify | — | |

**Versiones:** fijá la versión exacta de cada dependencia al instalarla y anotala
acá la primera vez. No uses rangos `^` en dependencias de producción.

Prohibido sin discusión previa: Prisma, TypeORM, Redis (todavía no hace falta),
microservicios, GraphQL, cualquier ORM o framework que no esté en esta tabla.

---

## 4. Estructura del monorepo

```
apps/
  api/          NestJS
  web/          Next.js
  mobile/       Expo
  worker/       procesos pg-boss (comparte código con api)
packages/
  contracts/    esquemas Zod + contratos oRPC. Fuente de verdad de la API
  db/           esquema Drizzle, migraciones, seeds
  config/       tsconfig, biome, validación de variables de entorno
infra/
  docker/       Dockerfiles y compose
  powersync/    sync rules
docs/
  requirements.md
  data-model.md
  adr/          una decisión por archivo
```

pnpm workspaces + Turborepo.

### Comandos

```bash
pnpm dev              # todo en modo desarrollo
pnpm dev:api          # solo la API
pnpm db:generate      # genera la migración desde el esquema Drizzle
pnpm db:migrate       # aplica migraciones
pnpm db:studio        # inspección
pnpm test             # unitarios
pnpm test:integration # con Testcontainers. Requiere Docker corriendo
pnpm check            # biome + tsc + dependency-cruiser
```

Antes de dar por terminada cualquier tarea: `pnpm check && pnpm test`.

---

## 5. Arquitectura: módulos y slices

### Los cinco módulos

| Módulo | Tablas que posee |
| --- | --- |
| `tenancy` | organization, organization_profile, member, site, member_site_access, guest_link, plan, subscription, usage_counter |
| `projects` | project, task, task_dependency, schedule_change, sop_template, sop_template_task, custom_field_definition |
| `scheduling` | resource, resource_booking |
| `collaboration` | task_update, attachment, task_acknowledgement |
| `notifications` | notification, notification_preference, escalation_policy |

Un módulo **no** importa el esquema Drizzle de otro ni hace join contra sus tablas.
Para leer datos de otro módulo, usás el servicio que ese módulo exporta. Para
reaccionar a algo, escuchás su evento de dominio: desde fase 2 (ADR-009) con el
`EventEmitter` nativo de Node, sin agregar un paquete de eventos.

`audit_log` es transversal: lo escriben triggers de base, ningún módulo lo escribe.

### Anatomía de un slice

Dentro de cada módulo, la organización es por caso de uso, no por capa técnica:

```
apps/api/src/modules/projects/
  projects.module.ts
  features/
    create-task/
      create-task.command.ts      entrada, tipada desde packages/contracts
      create-task.handler.ts      la lógica
      create-task.controller.ts   endpoint oRPC (@Implement del contrato)
      create-task.spec.ts         test
    reschedule-cascade/
    ...
  domain/                         entidades, máquinas de estado, invariantes
  infrastructure/                 repositorios Drizzle, adaptadores
```

Una tarea de desarrollo = un slice. Si estás tocando cuatro slices para un cambio,
probablemente el cambio va en `domain/`.

### Máquinas de estado

Las transiciones de `task.status` se validan en `domain/`, con una tabla explícita
de transiciones permitidas. Nunca con un trigger de base: un error de Postgres es
opaco para un capataz en un frente de obra.

---

## 6. Base de datos

Detalle completo en `docs/data-model.md`. Lo mínimo que tenés que respetar siempre:

- Columnas estándar en toda tabla: `id`, `organization_id`, `created_at`,
  `updated_at`, `deleted_at`, `version`, `created_by_member_id`.
- Todo en `timestamptz`, siempre UTC. La zona horaria vive en `organization_profile`
  y `site`. Cualquier regla de negocio con fechas se evalúa en hora local del sitio.
- Estados cerrados: `text` + `CHECK`, nunca enums nativos de Postgres.
- Claves foráneas compuestas `(organization_id, <id>)`.
- Orden manual: indexación fraccionaria en `position text`, no enteros.
- Todo índice de tabla de negocio arranca con `organization_id`.
- Nombres en `snake_case`, tablas en **singular** (`task`, `site`,
  `resource_booking`). Así queda consistente con las tablas de Better Auth
  (`user`, `session`, `member`), que son singulares y no se pueden renombrar.
- Toda migración que crea una tabla de negocio nueva termina con
  `select app_apply_tenant_policies();` **y** `select app_apply_version_triggers();`
  (ambas funciones viven en migraciones ya aplicadas — la primera en
  `0001_roles_rls`, la segunda en `0005_projects`, ver
  `packages/db/migrations/`). Las dos son idempotentes: cubren la tabla
  nueva sin tener que escribir la policy o el trigger de `version` a mano.
- **El código de aplicación consulta con SQL crudo** (`tx.execute(sql\`...\`)`),
  nunca con el query builder de Drizzle importando los objetos de tabla
  (`db.select().from(task)`). Los esquemas de `packages/db/src/schema/` son
  la fuente para `drizzle-kit generate`, no para armar queries en
  `apps/api/`. Es lo que hace cumplible la regla dura 5 (dependency-cruiser
  `no-cross-module-schema`): si un módulo importara el objeto de tabla de
  otro para usar el query builder, la regla lo bloquea recién ahí, pero con
  SQL crudo el problema ni se plantea — nada que importar.
- **Un `CHECK` o una `FOREIGN KEY` nueva sobre una tabla que ya tiene datos
  va con `ADD CONSTRAINT ... NOT VALID`, y el `VALIDATE CONSTRAINT` que la
  valida va en un despliegue posterior, nunca en la misma migración ni en
  el mismo *run* del migrador.** `DROP CONSTRAINT` + `ADD CONSTRAINT` (lo
  que genera `drizzle-kit` por default para modificar un `CHECK`) toma un
  lock exclusivo y revalida la tabla entera de una sola pasada; `NOT VALID`
  separa esa validación completa de la parte que sí necesita el lock
  exclusivo (agregar la constraint es instantáneo, no mira filas
  existentes).

  **Verificado, no supuesto** (`packages/db/node_modules/drizzle-orm/pg-core/dialect.js:60`,
  paquete `drizzle-orm@0.45.2` instalado — `PgDialect.migrate`, llamado desde
  `drizzle-orm/node-postgres/migrator.js`): el migrador de Drizzle envuelve
  **todas** las migraciones pendientes de una corrida en un solo
  `session.transaction(...)`, ejecutando cada archivo `.sql` dentro de ese
  mismo `tx`. Si el `ADD CONSTRAINT ... NOT VALID` y su `VALIDATE CONSTRAINT`
  quedan pendientes a la vez (por ejemplo, un ambiente que arranca de cero y
  corre todo junto), los dos terminan en la misma transacción: el lock
  exclusivo del `ADD` se mantiene hasta el `COMMIT` final, y `VALIDATE`
  revisa la tabla entera todavía adentro de ese lock — exactamente el
  problema que `NOT VALID` buscaba evitar. Por eso la regla es la misma que
  la regla dura 7 de `DROP COLUMN`: el `VALIDATE CONSTRAINT` es una
  migración aparte, para un despliegue posterior, nunca agrupada con el
  `ADD CONSTRAINT ... NOT VALID` en la misma corrida.

  El `ADD CONSTRAINT ... NOT VALID` en sí sigue pidiendo un lock exclusivo
  breve para registrar la constraint. Si hay una transacción larga abierta
  sobre esa tabla, el pedido de lock queda encolado y bloquea toda consulta
  que llegue detrás (incluidas lecturas). Anteponer `SET lock_timeout` (en
  la misma migración, antes del `ALTER TABLE`) hace que falle rápido en vez
  de congelar la tabla, para reintentarlo después.

  `drizzle-kit` no sabe generar `NOT VALID`: la migración que genera para
  modificar un `CHECK` (`DROP CONSTRAINT` + `ADD CONSTRAINT` a secas) se
  edita a mano. Para el caso más común, ampliar un `CHECK` ya existente
  (agregar un valor nuevo a la lista), la secuencia es:

  1. `SET lock_timeout = '...'; ALTER TABLE t ADD CONSTRAINT t_check_v2 CHECK (...) NOT VALID;` — la constraint vieja sigue activa, protegiendo.
  2. `ALTER TABLE t VALIDATE CONSTRAINT t_check_v2;` — despliegue posterior.
  3. `ALTER TABLE t DROP CONSTRAINT t_check;` — recién ahora, en un tercer paso.

  Mientras la vieja y la nueva conviven (pasos 1 y 2), la vieja sigue
  rechazando lo que ya rechazaba; nunca hay una ventana sin protección.

  Nada de esto aplica a una tabla recién creada en la misma migración (sin
  datos todavía no hay nada que revalidar) ni a las migraciones ya
  aplicadas de este repo (`0007_task_update_reopen_kind.sql` corrió con
  `task_update` vacía) — es la convención para las que vienen.

### El caso de las reservas

`resource_booking` tiene una exclusion constraint GiST que impide el traslape. No
la toques y no agregues locks en la aplicación. El flujo es: consultar solapamiento
para mostrar la advertencia, insertar normalmente, y traducir un
`exclusion_violation` de Postgres a la misma advertencia. El forzado inserta con
`is_override = true`, que el predicado de la constraint excluye a propósito, y
registra qué reservas pisó en `overridden_booking_ids`.

---

## 7. Multi-tenancy

Cada request entra a una transacción con el contexto seteado antes de cualquier
consulta:

```ts
await db.transaction(async (tx) => {
  await tx.execute(sql`
    select set_config('app.current_org',    ${orgId},     true),
           set_config('app.current_member', ${memberId},  true),
           set_config('app.request_id',     ${requestId}, true)
  `);
  return handler(tx);
});
```

El tercer parámetro `true` hace el valor local a la transacción. Sin eso, el pool
de conexiones filtra el contexto de un tenant al request siguiente. Es el bug más
grave que este sistema puede tener.

Los workers de pg-boss hacen lo mismo. Un job que procesa varios tenants abre una
transacción por tenant.

### Permisos

Cuatro niveles: `owner` y `director` (nivel 1, toda la organización), `manager`
(nivel 2, solo sus sitios vía `member_site_access`), `operator` (nivel 3, sus
tareas y su sitio). Los invitados del nivel 4 **no son usuarios**: acceden con un
token firmado con alcance y vencimiento, y reciben una proyección de solo lectura,
nunca la entidad completa.

Las capacidades (`task:create`, `booking:override`, `project:archive`) se definen
en código, en un mapa de rol a capacidades. Nunca en la base.

---

## 8. Contratos y API

`packages/contracts` es la única fuente de verdad de la forma de la API. Definís el
esquema Zod y el contrato ts-rest ahí; la API lo implementa, web y móvil lo
consumen. Nunca dupliques un tipo de request o response en `apps/`.

Errores: un tipo de error de dominio por caso, mapeado a HTTP en un filtro central.
Nunca tires `HttpException` desde un handler de dominio.

La respuesta de error siempre lleva un `code` estable que el cliente puede
interpretar, y un `message` en español apto para mostrarle al usuario.

---

## 9. Offline: qué implica al escribir código

El móvil escribe a través de la API, nunca directo a Postgres.

**Desde fase 2, todo endpoint de escritura acepta `client_mutation_id`** (UUIDv7),
no solo los que pueden originarse en el móvil: se adelantó por el mismo motivo
que roles y RLS se adelantaron a fase 1 — es cara de retrofitear (ver
ADR-007). Toda mutación:

- Acepta un `client_mutation_id` (UUIDv7) y lo registra en `mutation_log`. Un
  reintento devuelve el resultado anterior en vez de duplicar.
- Devuelve un motivo de rechazo legible cuando no se puede aplicar. Si el usuario
  no se entera de que su cambio se descartó, el offline está roto aunque la
  sincronización funcione.
- Respeta las reglas de conflicto: estados y novedades gana el cliente; fechas
  planificadas y asignaciones gana el servidor; reservas decide la base.

Las reservas creadas sin conexión entran como `tentative` y el servidor las
confirma o las rechaza al sincronizar.

Las sync rules de PowerSync (`infra/powersync/`) son código versionado. Cambiarlas
recalcula buckets, así que se prueban en staging antes de producción.

---

## 10. Tests

Obligatorio escribir test en estos casos, sin preguntar:

- **Aislamiento de tenant.** Existe un test parametrizado que recorre
  `information_schema` y verifica que ninguna tabla con `organization_id` deje leer
  o escribir filas de otra organización. Si agregás una tabla y falla, la que está
  mal es tu migración.
- **Concurrencia de reservas.** Dos transacciones simultáneas sobre el mismo
  recurso y franja: una gana, la otra recibe el error de exclusión.
- **Ciclos de dependencias.** Intentar cerrar un ciclo se rechaza.
- **Idempotencia de mutaciones.** El mismo `client_mutation_id` dos veces produce
  un solo efecto.
- **Escalamiento.** Una tarea vencida dispara el paso 1 y reencola el 2; una tarea
  completada no dispara nada.

Integración siempre con Testcontainers contra Postgres real. Nunca mockees la base:
la mitad de las garantías de este sistema viven en constraints y policies que un
mock no ejecuta.

---

## 11. Estilo

- Identificadores, nombres de archivo, columnas y commits: **inglés**.
- Textos de interfaz, mensajes de error al usuario, documentación y comentarios
  de negocio: **español rioplatense**.
- Funciones cortas, nombres explícitos, sin abreviaturas crípticas.
- Sin comentarios que repitan el código. Comentás el porqué, no el qué.
- Commits en formato convencional: `feat(scheduling): ...`, `fix(api): ...`.

---

## 12. Cómo trabajar acá

**Antes de escribir código:** leé el slice existente más parecido y seguí su forma.
La consistencia vale más que tu preferencia sobre cómo debería estructurarse.

**Si el requerimiento es ambiguo:** preguntá. No elijas una interpretación y sigas.
Este sistema tiene reglas de negocio con consecuencias reales (un quirófano
doblemente reservado, una alerta que no llega a un frente de mina).

**Si necesitás una decisión de arquitectura nueva:** proponela, esperá confirmación,
y una vez aprobada escribila como ADR en `docs/adr/` antes de implementarla.

**Si aparece un prerequisito que el brief no contemplaba** (por ejemplo, asumía
resuelta una fase anterior y no lo estaba): va en su propio PR, separado del
trabajo que lo necesita, y se mergea antes. No se mezclan en el mismo PR aunque
se hayan construido en la misma sesión — revisar "¿está bien esta base?" y
"¿está bien esta feature?" son dos preguntas distintas, y mezclarlas hace más
difícil revisar cualquiera de las dos a fondo.

**Nunca:** agregues dependencias sin preguntar, cambies el esquema sin actualizar
`docs/data-model.md`, desactives un test que falla, ni uses `--force` en migraciones.

---

## 13. Decisiones abiertas

Confirmar antes de implementar lo que dependa de ellas:

1. ~~Profundidad de subtareas~~ — **cerrada en fase 2** (ver ADR-006): se
   mantiene `ltree` en el esquema (profundidad libre a nivel de base), pero
   la capa de dominio limita a tres niveles con una constante, no con un
   `CHECK`.
2. Recursos con capacidad mayor a uno (hoy cada unidad física es un recurso).
3. Si se permiten reservas sin conexión (hoy sí, como `tentative`).
4. Retención del audit log en meses.
5. Si `project.site_id` es obligatorio. **Sigue abierta** — fase 2 solo definió
   un fallback para cuando es nulo (`organization_profile.timezone` para
   resolver la zona horaria de una tarea, ver ADR-008), no resolvió la
   pregunta de si debería ser `NOT NULL`.
6. Idempotencia de mutaciones con payload distinto bajo el mismo
   `client_mutation_id`: hoy `mutation_log` no guarda un hash del request, así
   que un reintento con el mismo `client_mutation_id` pero datos distintos
   devuelve el resultado anterior en silencio, sin avisar del mismatch. Falta
   decidir si eso alcanza (es la semántica que ADR-007 ya documenta) o si hace
   falta guardar un hash del payload y rechazar el reintento si no coincide.
7. `task_update.created_by_member_id` para entradas de tipo `system`: la
   columna es `NOT NULL` como en cualquier tabla de negocio, pero un
   `task_update` generado por un proceso automático (reprogramación en
   cascada, fase 5) no tiene un miembro humano detrás. Ninguna funcionalidad
   de fase 2 escribe ese tipo de fila, así que queda diferido: definir un
   miembro de sistema reservado, o relajar la columna a nulable para ese
   caso, cuando se implemente la fase que de verdad lo necesita.

---

## 14. Orden de construcción

No adelantes fases. Cada una tiene que estar andando y probada antes de la siguiente.

1. Esqueleto, CI, deploy, auth y tenancy de punta a punta.
2. Proyectos, tareas y subtareas, asignación, estados, vista "Mi Día",
   notificaciones, audit trail, dashboard básico.
3. Recursos, reservas con conflicto y forzado, plantillas SOP, campos personalizados.
4. Offline con PowerSync y cola de fotos.
5. Dependencias, hitos, reprogramación en cascada.
6. Analytics, KPIs, exportación PDF y Excel.
7. Facturación, planes, límites, onboarding.
