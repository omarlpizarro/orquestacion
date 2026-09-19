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
   corre como `app_user`, que no tiene `BYPASSRLS`.
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

Decidido y cerrado. No propongas alternativas salvo que te lo pidan explícitamente.

| Capa | Herramienta | Nota |
| --- | --- | --- |
| Runtime | Node LTS | Fijar versión exacta en `.nvmrc` al iniciar |
| Lenguaje | TypeScript, `strict: true` | Sin `any` salvo en límites de terceros, con comentario |
| API | NestJS con adaptador Fastify | Módulos = fronteras del monolito modular |
| Base de datos | PostgreSQL 17 | Extensiones: `btree_gist`, `pg_trgm`, `pgcrypto`, `ltree` |
| ORM | Drizzle | SQL-first. Migraciones con `drizzle-kit` |
| Contratos | Zod + ts-rest | Fuente única en `packages/contracts` |
| Auth | Better Auth + plugin `organization` | Tablas generadas por su CLI, no se editan a mano |
| Jobs | pg-boss | Sobre el mismo Postgres. Encolado transaccional |
| Offline | PowerSync (Open Edition, self-hosted) | Bucket storage en Postgres separado |
| Móvil | Expo / React Native | SQLite vía PowerSync |
| Web | Next.js App Router | |
| PDF | Playwright renderizando una ruta de `apps/web` | Contenedor aparte |
| Excel | ExcelJS | |
| Storage | S3-compatible (MinIO en dev, R2 o MinIO en prod) | Presigned URLs |
| Lint y formato | Biome | Reemplaza ESLint y Prettier |
| Tests | Vitest + Testcontainers | Postgres real en integración, nunca mocks de base |
| Fronteras | dependency-cruiser | Falla el build si un módulo cruza |
| Infra | Docker Compose sobre Ubuntu LTS, gestionado con Coolify | |

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
  contracts/    esquemas Zod + contratos ts-rest. Fuente de verdad de la API
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
reaccionar a algo, escuchás su evento de dominio.

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
      create-task.controller.ts   endpoint ts-rest
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
- Nombres en `snake_case`, tablas en plural.

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

El móvil escribe a través de la API, nunca directo a Postgres. Toda mutación que
puede originarse en el móvil:

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

**Nunca:** agregues dependencias sin preguntar, cambies el esquema sin actualizar
`docs/data-model.md`, desactives un test que falla, ni uses `--force` en migraciones.

---

## 13. Decisiones abiertas

Confirmar antes de implementar lo que dependa de ellas:

1. Profundidad de subtareas: árbol libre con `ltree` o dos niveles fijos.
2. Recursos con capacidad mayor a uno (hoy cada unidad física es un recurso).
3. Si se permiten reservas sin conexión (hoy sí, como `tentative`).
4. Retención del audit log en meses.
5. Si `project.site_id` es obligatorio.

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
