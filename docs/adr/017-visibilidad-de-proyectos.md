# 017. Visibilidad de proyectos: reservados por defecto, con RLS por proyecto

- **Estado:** aceptada
- **Fecha:** 2026-10-02

## Contexto

Hasta ahora el alcance se decide por **sitio** (`member_site_access`, ADR-015 y
ADR-016): quien trabaja en un sitio ve todo lo de ese sitio. Omar sumó un
requisito que va antes del CRUD de proyectos: **los proyectos son reservados por
defecto.** Un manager del sitio no tiene por qué ver el proyecto de la gerencia
general que corre en ese mismo sitio, ni un operario las tareas de un proyecto en
el que no participa.

Esto es un segundo eje de acceso, independiente del sitio, y tiene que cumplir lo
mismo que el aislamiento entre organizaciones: la aplicación decide con buenos
mensajes de error, y la base lo impone con RLS como segunda línea (CLAUDE.md §2,
reglas 2 y 3). Una sola de las dos capas no alcanza.

El mecanismo se probó en un Postgres 17 descartable antes de escribir este ADR
(ver "Lo verificado").

## Decisión

### 1. Tres niveles de acceso, siempre calculados

Un miembro tiene sobre un proyecto uno de estos niveles. Nunca se guarda: se
deriva en cada consulta.

- **Completo.** `owner` y `director`, siempre. Para el resto: ser **miembro
  explícito** del proyecto, o que el proyecto sea `visibility = 'site'` y el
  miembro tenga acceso a su sitio (`canAccessSite`, ADR-015).
- **Solo asignado.** Tener al menos una tarea asignada, **no borrada, en
  cualquier estado** (`done` y `cancelled` cuentan), en el proyecto. Ve el
  proyecto y **únicamente sus propias tareas**, con sus novedades. Una subtarea
  asignada a otra persona dentro de una tarea suya no la ve.
- **Ninguno.** El recurso no existe para esa persona.

La asignación da el nivel "solo asignado" aunque el proyecto sea `site`. Por eso
un asignado que perdió el acceso al sitio sigue viendo y moviendo su tarea, y
desasignar a alguien le quita el acceso sin que nadie tenga que acordarse.

### 2. Modelo de datos

- **`project.visibility`** `text NOT NULL DEFAULT 'reserved'`, `CHECK (visibility
  IN ('reserved','site'))`. Los proyectos que ya existan se pasan a `site` en la
  migración, para no cambiar lo que ven hoy (con la tabla vacía es indiferente).
  El `CHECK` sigue la convención `NOT VALID` + `VALIDATE` en despliegues
  separados (CLAUDE.md §6).
- **`project_member`**, con las columnas estándar (`id`, `organization_id`,
  `created_at`, `updated_at`, `deleted_at`, `version`, `created_by_member_id`),
  `project_id`, `member_id` (`text`, ADR-010). FK compuesta
  `(organization_id, project_id)`. Quitar a alguien es `deleted_at` (regla dura
  9); índice único parcial `(project_id, member_id) WHERE deleted_at IS NULL` e
  índice `(organization_id, member_id, project_id) WHERE deleted_at IS NULL`.
  Sin rol: el rol sale siempre de la organización (ADR-015).
- **El creador queda como miembro** en la misma transacción que crea el
  proyecto, desde el handler (no un trigger). Se inserta también si es `owner` o
  `director`: la fila sobrevive a un cambio de rol, por el mismo motivo que en
  ADR-016.
- **`project_id` copiado en las tablas hijas** (`task_update`, `attachment`,
  `task_acknowledgement`; nullable en `notification` y `resource_booking`, que
  no siempre cuelgan de una tarea). Es lo mismo que ya hacemos con
  `organization_id` "aunque parezca redundante": la policy queda como un chequeo
  de una columna y el test de aislamiento puede recorrer el catálogo buscando
  `project_id`. Para que la copia no pueda diverger, la base lo impone:
  - `UNIQUE (organization_id, id, project_id)` en `task`, y en cada hija una FK
    `(organization_id, task_id, project_id) → task (organization_id, id,
    project_id)`.
  - **El proyecto de una tarea no se puede cambiar.** Un trigger
    `BEFORE UPDATE` rechaza cualquier `UPDATE` que modifique `project_id` en
    `task`, en las hijas y en `project_member`; se aplica por catálogo con una
    función `app_apply_project_immutability()` que termina cada migración que
    crea una tabla con `project_id`, igual que `app_apply_tenant_policies()`. No
    es una máquina de estados (CLAUDE.md §5 pide guards de aplicación para esas):
    es una invariante de integridad sin mensaje útil que mostrarle a nadie,
    porque ningún endpoint mueve tareas de proyecto; el trigger es la red de
    seguridad. Aplica también al dueño del esquema.
  - La hija se agrega siguiendo el principio "las migraciones solo agregan":
    columna nullable, backfill, `CHECK ... NOT NULL NOT VALID`, y el `VALIDATE`
    en un despliegue posterior.
- **`sop_template.project_visibility`** (nullable): los proyectos creados desde
  una plantilla nacen con esa visibilidad, para que las operaciones de rutina
  nazcan abiertas sin que nadie decida. Al crear: visibilidad pedida ?? la de la
  plantilla ?? `reserved`. Va dentro de la migración que crea `sop_template`
  (fase 3), así que el CRUD de proyectos de fase 2 todavía no lo lee.
- **Acceso por asignación: sin tabla.** Se deriva de `task`. Índice nuevo
  `task (organization_id, assignee_member_id, project_id) WHERE deleted_at IS
  NULL`.

### 3. RLS por proyecto

**Cómo saben las policies quién es.** Leen `app.current_org` y
`app.current_member` (ya existen) y resuelven el rol **en la base**, desde
`auth.member`. No se agrega un tercer GUC con el rol: un handler que se
equivoque no puede declararse director. `owner`/`director` se reconocen como en
`hasImplicitAllSitesAccess`; un test cruza las dos definiciones.

**Funciones auxiliares.** Si la policy de `project` lee `task` y la de `task`
lee `project`, Postgres falla con `infinite recursion detected in policy`
(verificado). El ciclo se corta con funciones `STABLE SECURITY DEFINER`, de
`search_path` fijo, cuyo dueño es un rol sin login con `BYPASSRLS`. Son
exactamente estas, y nada más:

| Función | Devuelve |
| --- | --- |
| `app_is_privileged()` | `boolean` |
| `app_full_access_project_ids()` | `setof uuid` |
| `app_assigned_project_ids()` | `setof uuid` |
| `app_assigned_task_ids()` | `setof uuid` |
| `app_has_full_project_access(project_id)` | `boolean` |
| `app_has_assigned_project_access(project_id)` | `boolean` |

Las dos últimas son para la aplicación (`ProjectAccessService`, módulo
`projects`): hay **una sola** implementación del cálculo, la de la base, y el
código no la reescribe en TypeScript. Las policies usan las primeras cuatro como
subconsultas no correlacionadas (`project_id IN (SELECT ...)`), que Postgres
calcula una vez por sentencia, no por fila.

Las funciones leen `member_site_access` (una tabla de `tenancy`) desde SQL. La
regla dura 5 prohíbe que un **módulo** consulte tablas de otro; esto es
infraestructura de base, no código de módulo, y se acepta explícitamente. El
test cruza la respuesta de la base con `TenancyService.canAccessSite` para toda
combinación de rol y fila.

**Policies, por comando.** No una sola `FOR ALL`:

- `SELECT`/`UPDATE`/`DELETE` sobre `task`: organización, y (privilegiado, o
  proyecto con acceso completo, o tarea asignada al miembro).
- `INSERT` sobre `task`: organización, y (privilegiado o acceso completo). **Sin
  la rama "asignada"**: con una sola policy, alguien con acceso "solo asignado"
  podría insertar tareas en un proyecto que ve únicamente por asignación.
- Hijas (`task_update`, `attachment`, `task_acknowledgement`): `SELECT` con
  acceso completo o tarea asignada (`app_assigned_task_ids`); `INSERT` con lo
  mismo, porque quien tiene una tarea asignada tiene que poder escribir en ella
  (un bloqueo es un `task_update`).
- `project`: organización, y (privilegiado, o acceso completo, o asignado).
- `project_member`: privilegiado o acceso completo al proyecto. El asignado no
  ve quién más participa.
- `audit_log`: `SELECT` para privilegiados y para quien tiene acceso completo al
  `project_id` de la entrada; las que no tienen `project_id` solo las ven los
  privilegiados. `INSERT` solo por organización (lo hace el trigger).

### 4. Condiciones del rol auxiliar

Es un rol con `BYPASSRLS`, y la regla dura 4 dice que la aplicación nunca usa
uno. Se aprueba con tres condiciones, que son parte de la decisión y las verifica
un metatest:

1. **Las funciones devuelven solo booleanos o listas de IDs, nunca columnas de
   datos.** El peor resultado de una función auxiliar mal usada es saber que un
   id existe, no leer su contenido.
2. **Ningún rol de la aplicación puede asumir ese rol.** Sin membresías en
   ningún sentido (ni el rol es miembro de otro, ni otro lo es de él, ni por
   herencia), sin `SET ROLE`, y es `NOLOGIN`. La aplicación nunca se conecta con
   él: solo es el dueño de las funciones.
3. **Mínimo privilegio.** Solo `SELECT`, y solo sobre las tablas que las
   funciones leen (`project`, `project_member`, `task`, `member_site_access`,
   `auth.member`). Dueño de esas funciones y de nada más. Cada función filtra
   siempre por `organization_id = app.current_org`; llamada con la organización
   de otro tenant no devuelve nada de la primera.

**El metatest verifica**, además de dueño y permisos:

- que el conjunto de funciones auxiliares es exactamente el de la tabla de
  arriba, que ninguna otra pertenece al rol, y que todas son `SECURITY DEFINER`
  con `search_path` fijo y `EXECUTE` solo para `app_user` (no para `PUBLIC`);
- que `pg_proc.prorettype` de cada una es `boolean` o `uuid` (este último solo
  como `setof`) — nunca un tipo compuesto, `text` ni `jsonb`;
- que el rol es `NOLOGIN` y `BYPASSRLS`, que `pg_auth_members` no lo relaciona
  con ningún otro rol, y que **ningún otro rol** de la base tiene `BYPASSRLS` ni
  `SUPERUSER` salvo el de arranque;
- que, conectado como `app_login` y como `app_worker`, `SET ROLE
  app_rls_helper` falla;
- que sus privilegios son exactamente los `SELECT` enumerados;
- que llamar a cada función con el contexto de la organización B no devuelve
  ningún id de la A.

### 5. Contexto de sistema, garantizado por la base

Los workers y los scripts se conectan con **su propio usuario de base**,
`app_worker` (login, miembro de `app_user`), distinto de `app_login`, el de la
API. `withSystemTransaction({ organizationId, reason })` fija la organización y
`app.scope = 'system'` y no setea `app.current_member`.

`app_is_privileged()` devuelve `true` por sistema **solo si** `app.scope =
'system'` **y** `session_user = 'app_worker'`. Se usa `session_user` y no
`current_user` porque dentro de una función `SECURITY DEFINER` este último es el
dueño de la función; `session_user` es el usuario con el que se abrió la
conexión, y cambiarlo exige ser superusuario. Así la API no puede declararse
sistema aunque fije el GUC: el privilegio lo concede la identidad de la
conexión, no un valor que el código escribe.

- Un job que actúa **en nombre de una persona** usa el contexto de esa persona
  (miembro), que es lo mínimo necesario; el contexto de sistema es para lo que de
  verdad necesita ver toda la organización (escalamientos, reparaciones).
- Una regla de dependency-cruiser deja importar `withSystemTransaction` solo a
  `apps/worker` y a los scripts, nunca a la ruta de requests. Es una barrera
  contra errores; la barrera contra una API comprometida es el usuario de base.
- `app.request_id` lleva el prefijo `system:<job>`, y el trigger de auditoría lo
  registra con `actor_kind = 'system'`.
- El metatest agrega: con `app_login`, fijar `app.scope = 'system'` no amplía lo
  que se ve; con `app_worker`, sí.

### 6. Respuestas: 404 si no lo ves, 403 si lo ves y no podés

Si alguien no puede ver un recurso, recibe **404**, igual que si no existiera. Si
lo ve pero no puede modificarlo, **403**. RLS produce el 404 solo, porque la
lectura devuelve "no existe". El orden en los slices es: **404 → 403 → versión
(409)** (la autorización va antes de la versión, para no contarle a quien no
puede tocar la tarea que cambió).

Consecuencias en lo que ya existe (PR #25):

- `TaskSiteAccessForbiddenError` **desaparece**: un manager sin acceso al sitio
  de un proyecto abierto al sitio no lo ve, y recibe 404. El 404 entra con este
  modelo, no en #25.
- `create-task` busca el proyecto antes de mirar la capacidad: un `operator` que
  crea en un proyecto que no ve recibe 404, no 403. Crear exige acceso
  completo.
- El dominio de `change-task-status` deja de recibir `hasSiteAccess`; recibe si
  el miembro tiene acceso completo al proyecto. La regla "manager sin acceso" sale
  del dominio.

### 7. La excepción del operator

Un `operator` puede marcar como `blocked` una tarea **sin asignar** que ve con
**acceso completo**: un proyecto abierto al sitio de su sitio, o un proyecto
reservado del que es **miembro explícito**. En un proyecto reservado donde no
participa no ve la tarea (404). La regla del dominio queda
`isAssignee || (accesoCompleto && sinAsignar && to === 'blocked')`.

### 8. Quién cambia la visibilidad y quién maneja los miembros

- **Cambian la visibilidad:** el creador (`project.created_by_member_id`), `owner`
  y `director`. **Agregan y quitan miembros:** los mismos. Cualquier miembro
  puede salirse a sí mismo. Se puede agregar a cualquier miembro de la
  organización, sin requisito de acceso al sitio.
- **Un miembro explícito sin acceso al sitio actúa según su rol.** Haberlo
  agregado a un proyecto es una decisión deliberada que pesa más que el sitio. El
  sitio sigue importando en proyectos `site`.
- **Asignabilidad** (`isMemberAssignable`): existe en la organización y
  (`canAccessSite` con su rol, o es miembro explícito del proyecto).
- **Quitar a un miembro no toca sus tareas.** Pierde el acceso completo y, si le
  quedan tareas asignadas, conserva el nivel "solo asignado". La respuesta
  informa cuántas le quedan para que alguien decida si reasignar. No se
  desasigna en silencio: cambiaría Mi Día y las notificaciones.
- **Al creador lo quitan solo `owner` o `director`**, y pierde todo salvo lo que
  le quede por asignación. Pierde también el derecho de cambiar la visibilidad:
  sin verlo, recibe 404.
- Las capacidades (`project:change_visibility`, `project:manage_members`) se
  definen en código; la condición "es el creador" es un dato del proyecto que
  evalúa el handler.

### 9. Registro: `audit_log` se adelanta

Pasar de `reserved` a `site` ensancha quién ve el proyecto, y tiene que quedar
registrado con quién y cuándo. Se adelanta la tabla `audit_log` y los triggers
de **`project` y `project_member`**, con el mismo criterio que ya aplicamos a
`mutation_log` (`0004`) y a `task_update` (`0006`). El paso 8 del brief extiende
los triggers a `task` y al resto.

Al adelantarla hay que corregir dos cosas que `docs/data-model.md` describe mal
hoy:

- `actor_member_id` y `entity_id` están como `uuid`; los miembros son `text`
  (ADR-010) y `member_site_access` no tiene `id`. `actor_member_id` pasa a
  `text`.
- Se agrega `project_id` (nullable) para poder filtrar la lectura por proyecto;
  el trigger lo llena (`project`: su propio `id`; `project_member`: su
  `project_id`).

La tabla es particionada por `created_at`. Se crean una partición `DEFAULT` y las
de los próximos meses; el job que crea las siguientes y la retención (decisión
abierta #4 de CLAUDE.md §13) quedan para el paso 8. `REVOKE UPDATE, DELETE ON
audit_log FROM app_user` va en la misma migración.

### 10. Mi Día e índices

Mi Día no cambia el resultado: una tarea asignada al miembro siempre la ve. Lo
que cambia es el costo: cada consulta sobre `task` evalúa la policy. El test de
rendimiento (`EXPLAIN`) tiene que seguir mostrando el uso del índice compuesto
con la policy puesta, y se revalida en el PR de comportamiento. Para
privilegiados, `app_is_privileged()` se evalúa una vez por sentencia
(`InitPlan`); los proyectos visibles, una vez (`hashed SubPlan`).

### 11. Configuración por organización (prevista, sin implementar)

`organization_profile.allow_site_visibility boolean` (default `true`; si la fila
no existe, `true`) permitirá a un cliente desactivar la opción `site` y tener
todo reservado. Si es `false`, la API rechaza `site`, una plantilla con `site`
cae a `reserved`, y las funciones auxiliares dejan de tratar `visibility = 'site'`
como acceso completo, así que apagarla surte efecto de inmediato aunque queden
proyectos `site`. Las funciones son el único lugar donde va esa cláusula. No se
agrega la columna en estos PRs.

## Lo verificado

En un Postgres 17 descartable, con tablas y roles mínimos equivalentes:

- Dos policies que se leen mutuamente (`project` ↔ `task`) fallan con `infinite
  recursion detected in policy`.
- Con funciones `SECURITY DEFINER` de dueño `NOLOGIN` + `BYPASSRLS`, el ciclo se
  corta: el operario asignado ve 1 proyecto y 1 tarea (la suya), el miembro
  explícito ve su proyecto, el owner ve todo, un miembro desconocido y una
  sesión sin organización ven cero filas.
- El rol auxiliar necesita `USAGE` en los esquemas y `SELECT` en las tablas que
  leen las funciones; sin eso falla con `permission denied`, lo cual confirma que
  se le puede dar exactamente el mínimo.
- Llamada con otra organización, una función devuelve cero filas.
- El plan muestra `InitPlan` para `app_is_privileged()` y `hashed SubPlan` para
  el conjunto de proyectos visibles.

**No se verificó** si alguna variante sin `BYPASSRLS` corta el ciclo, y
`session_user` como base de la identidad de sistema se verifica contra el
Postgres real en el PR de comportamiento (ver Plan).

## Alternativas descartadas

- **Policies que se leen entre tablas, sin funciones auxiliares.** Recursión
  (verificado).
- **Un tercer GUC `app.current_role`.** Lo afirma la aplicación; un error en un
  handler cambiaría el rol que ve la base.
- **Guardar el acceso por asignación en una tabla.** Hay que acordarse de
  mantenerla al desasignar; derivarlo hace que el acceso se vaya solo.
- **Que el contexto de sistema sea solo un GUC.** Cualquier código de la API
  podría fijarlo; por eso lo concede la identidad de la conexión.
- **Resolver la visibilidad en TypeScript, además de en SQL.** Dos
  implementaciones que se desincronizan; la aplicación pregunta a la base.

## Consecuencias

- **Estructura en tres PRs** (CLAUDE.md §12): (1) este ADR, solo; (2) la
  estructura, sin cambiar comportamiento: `project.visibility`, `project_member`,
  `project_id` en las hijas con su FK compuesta y la inmutabilidad, `audit_log`
  con los triggers de `project`/`project_member`, los roles `app_rls_helper` y
  `app_worker` (sin policies nuevas todavía); (3) el comportamiento, que va
  junto: funciones auxiliares, policies, `withSystemTransaction`, el test de
  aislamiento por proyecto, el metatest y la adaptación de `create-task` y
  `change-task-status`. El CRUD de proyectos va después.
- **Test de aislamiento por proyecto.** Recorre el catálogo buscando toda tabla
  con `project_id` y falla si hay una con `task_id` sin `project_id`; exige una
  fixture registrada por tabla (una tabla nueva sin fixture falla); con siete
  actores —owner, director, creador, miembro explícito, asignado no miembro,
  manager del mismo sitio sin ser miembro, operator ajeno— verifica qué ve y que
  no puede escribir, y cubre desasignar, quitar un miembro y pasar `reserved →
  site`.
- **Despliegue.** Hay una segunda cadena de conexión (la de `app_worker`) en el
  `.env`, la validación de variables y `compose.server.yml` (ADR-014), y el
  arnés de tests levanta los roles nuevos. Verificar que pg-boss funciona con
  ese usuario.
- **CLAUDE.md regla dura 4** dice que ni `app_login` ni `app_user` tienen
  `BYPASSRLS`; sigue siendo cierto. Falta aclarar que existe un tercer rol, el
  dueño de las funciones auxiliares, que sí lo tiene, es `NOLOGIN` y no lo asume
  nadie. Ese ajuste de texto va en el PR de estructura, con tu confirmación.
- **Fuera de las tablas con policy.** `project_kpi` es una vista materializada y
  no admite RLS: se consulta filtrando por los proyectos visibles, o se hace
  tabla (fase 6). `resource_booking` de una tarea de un proyecto reservado se
  muestra como "ocupado", sin título, y el conflicto de exclusión igual revela
  que la franja está tomada. `custom_field_definition` y `escalation_policy`
  con `project_id` llevan la misma policy. `guest_link` solo se crea sobre un
  proyecto que quien lo crea puede ver. Para el nivel "solo asignado" el DTO del
  proyecto es reducido (sin descripción ni campos personalizados): RLS filtra
  filas, no columnas.
- **PowerSync** replica por un rol que no pasa por RLS: sus sync rules tienen que
  implementar este modelo y tener su propia batería de tests (fase 4). Un
  miembro al que se le quita el acceso deja de recibir las filas en la próxima
  sincronización.
