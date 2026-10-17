# 019. Avisos dentro de la app: en la transacción de la mutación, y una bandeja propia para el resto

- **Estado:** aceptada
- **Fecha:** 2026-10-17

## Contexto

El paso 8 del brief (notificaciones, parte 1) pide avisos dentro de la app: cuando se asigna una
tarea, a la persona asignada; cuando se bloquea, a quien puede ver el proyecto y a nadie más. El
push queda para la parte 2.

La condición que importa es que **un aviso no se pierda si la API se reinicia**. Tres hechos del
sistema condicionan cómo cumplirla:

- **ADR-009 lo dice de frente:** el `EventEmitter` no tiene entrega garantizada. Si el proceso cae
  entre el commit y el listener, el evento se pierde, y "el día que un efecto de un evento de
  dominio necesite garantía de entrega, ese efecto va encolado con pg-boss". El brief hablaba de
  crear los avisos "a partir de los eventos de dominio"; con esa garantía exigida no se puede.
- **La API no puede encolar en pg-boss.** Solo `app_worker` tiene permisos sobre el esquema
  `pgboss`, y la API no recibe su contraseña (ADR-017 §5): con ella podría declararse "sistema" en
  las policies.
- **Quien bloquea puede no ver a quién avisar.** La audiencia de un bloqueo son los miembros
  explícitos del proyecto, pero `project_member` solo lo lee quien tiene acceso completo (ADR-017:
  "el asignado no ve quién más participa"). El caso más común de bloqueo es un operario "solo
  asignado" en un proyecto reservado (el valor por defecto): la transacción que bloquea no puede
  armar la lista. Avisar solo a quien el actor ve dejaría sin aviso justo el caso que importa.

## Decisión

### 1. Los avisos se crean en la transacción de la mutación, no desde el `EventEmitter`

Los handlers de `create-task`, `assign-task` y `change-task-status` llaman, dentro de su
transacción, a un servicio que `notifications` exporta (`NotificationsService`, igual que
`projects` usa `CollaborationService` para `task_update`). El cambio y el aviso confirman juntos o
ninguno confirma; no hay nada en memoria que un reinicio pueda perder. Los eventos de dominio
siguen emitiéndose después del commit, para consumidores que toleren perderse; ningún aviso
depende de ellos.

### 2. Dos mecanismos, según se conozca o no al destinatario

| Aviso | Quién lo crea | Dónde |
| --- | --- | --- |
| Asignación (`task.assigned`), también al crear una tarea ya asignada | La API | La misma transacción. Solo a la persona asignada; no a quien se asigna a sí mismo ni a quien perdió la tarea. Desasignar no avisa |
| Bloqueo, al responsable de la tarea (`task.blocked`) | La API | La misma transacción. Salvo que el responsable sea quien bloqueó: ve su propia tarea y no se revela nada |
| Bloqueo, al resto de la audiencia | El worker | Lo pide la API con una fila de `notification_outbox` en la misma transacción |

### 3. Por qué una bandeja propia y no la cola de pg-boss desde la base

La alternativa natural era encolar el trabajo en pg-boss en la misma transacción, que es lo que
sugería `data-model.md`. Se descarta:

- La API no tiene permisos sobre `pgboss`. Dárselos (o una función `SECURITY DEFINER` que escriba
  ahí) abre una vía para encolar trabajos arbitrarios que el worker ejecuta con privilegios de
  sistema.
- Escribir en `pgboss.job` desde SQL replica columnas internas de pg-boss 12.33.2
  (`insertJobs` arma más de veinte campos). Eso ata el esquema de la base a la versión de una
  librería: subir pg-boss pasaría a poder romper una función de la base. **La base no escribe en
  las tablas internas de pg-boss.**
- Una bandeja propia es una tabla de negocio normal: tiene RLS de tenant, pasa por las
  `app_apply_*`, la escribe la API con su identidad de siempre, y se prueba con las mismas
  herramientas que el resto.

El costo es que la bandeja se sondea (cada 5 segundos) en lugar de despertar al worker. Es
aceptable: un aviso dentro de la app tarda segundos, y un worker caído demora los avisos pero no
los pierde (la fila queda pendiente). **El push de la parte 2 usa el mismo patrón**: una fila
`channel='push'`, `status='queued'`, que un job levanta con `FOR UPDATE SKIP LOCKED`.

### 4. La bandeja (`notification_outbox`)

Una fila por pedido, con lo mínimo: `organization_id`, `kind` (hoy `task.blocked`), `entity_id` (el
id de la novedad `task_update`), `processed_at` nulo, más las columnas estándar. Es un conjunto
abierto de tipos, sin `CHECK`: un tipo nuevo no debería exigir ampliar una constraint, y el
worker registra como error el que no conoce. `UNIQUE (organization_id, kind, entity_id)`: encolar
dos veces lo mismo (un reintento) no duplica el trabajo.

El worker (`apps/worker`) la recorre cada 5 segundos:

1. **Localiza** los pendientes de todas las organizaciones (`withSystemScanTransaction`, sin
   organización), con una policy de lectura transversal reservada a `app_worker` (punto 6).
2. **Procesa cada fila en su propia transacción**, de sistema y de su organización
   (`withSystemTransaction`): la toma con `FOR UPDATE SKIP LOCKED` (si otro worker la tiene,
   sigue de largo), **recalcula todo desde la base** (no confía en la fila más allá de los ids:
   un tipo desconocido, una novedad que no es un bloqueo, una tarea o un proyecto borrados no
   avisan a nadie), arma la audiencia, inserta los avisos con `dedupe_key` y `ON CONFLICT DO
   NOTHING`, y marca `processed_at`. Todo o nada.
3. **Si falla**, la transacción se deshace y la fila queda pendiente. En otra transacción se suma
   `attempts`, se guarda `last_attempt_at` y `last_error`. Los reintentos esperan
   `min(intentos, 6) × 30 s`, y a los 10 intentos la fila **deja de reintentarse y sigue
   pendiente, a la vista**: no se reintenta para siempre en silencio ni se descarta.

Las filas procesadas no se borran (regla dura 9). Crece una fila por bloqueo; es chica.

### 5. Audiencia de un bloqueo

Los miembros explícitos del proyecto (el creador incluido); si el proyecto es `site`, también los
`manager` con acceso a ese sitio; el responsable de la tarea; menos quien reportó el bloqueo. `owner` y
`director` solo si son miembros explícitos: nunca por ser privilegiados, porque avisarle a quien
no ve un proyecto reservado revelaría que existe. Solo miembros que siguen en la organización
(`project_member` no tiene FK hacia `auth.member`, ADR-010). El rol `manager` se compara por
valor completo: un miembro con varios roles queda afuera, el mismo lado seguro que
`app_is_privileged()`.

Tiene un test con la regla (proyecto reservado: un manager del sitio, un owner no miembro y un
operario ajeno no reciben; un miembro explícito sí; y un owner que además es miembro explícito
sí).

### 6. RLS

- **`notification` recibe las policies por proyecto** de `app_apply_project_policies()`, porque
  tiene `task_id` y `project_id`. No hizo falta ninguna columna nueva para que el operario "solo
  asignado" lea y marque su aviso: la policy deja pasar `task_id IN app_assigned_task_ids()`.
  Efecto buscado: quien pierde el acceso al proyecto deja de ver sus avisos de él, y quien solo
  tenía una tarea asignada deja de ver su aviso si la borran (la fila queda; la policy la esconde).
- **Policy por destinatario**, `RESTRICTIVE`, en `SELECT` y `UPDATE` únicamente
  (`recipient_member_id = app.current_member`). **No en `INSERT`**: quien asigna o bloquea crea
  avisos para otros. No usa `app_is_privileged()`: `owner` y `director` no leen los avisos ajenos.
- **Un `INSERT ... RETURNING` del aviso de otra persona falla**, porque la policy de lectura se
  evalúa sobre la fila devuelta. Los avisos para otros se insertan sin `RETURNING`; está probado.
- **`notification_outbox_system_scan`**, policy permisiva de `SELECT` para
  `session_user = 'app_worker'` con `app.scope = 'system'` y sin organización: es lo único que deja
  al worker encontrar trabajo de todas las organizaciones. Se escribió sin `app_is_privileged()`:
  su rama de `owner`/`director` dejaría a un dueño de una organización leer la bandeja de otra.
  Está probado que ni declarar `app.scope = 'system'` desde `app_login` ni `app_worker` sin ese
  alcance abren nada, y que el mismo alcance no abre ninguna otra tabla.

### 7. Excepción deliberada a la regla dura 5

El cálculo de la audiencia lee tablas de varios módulos (`task_update`, `task`, `project`,
`project_member`, `member_site_access`, `auth.member`) con SQL crudo en `apps/worker`. La regla
dura 5 es sobre módulos de la API, y `dependency-cruiser` la sigue haciendo cumplir allí; el
worker es el proceso privilegiado y esa lectura es una proyección, no un servicio. La
alternativa, pasar la audiencia por servicios exportados de cada módulo, no se puede: ejecutaría
con la identidad de quien actúa, que es justo lo que no alcanza a ver. Queda escrita en un solo
lugar (`notifications-outbox.ts`).

### 8. Endpoints

- `GET /notifications?unread_only&limit&cursor`: los avisos propios, del más nuevo al más viejo.
  Se ordena por `id` (UUIDv7, ordenable por tiempo) y el cursor es el último `id`: es exacto, sin
  perder precisión de timestamps. Trae `unread_count` (el número del badge, de todas las
  páginas). Página de 50 por defecto, máximo 100.
- `POST /notifications/{id}/read`: marca como leído un aviso propio. Acepta `client_mutation_id`;
  sin `expected_version` ("gana el último"); marcar uno ya leído devuelve el mismo `read_at`; 404
  si no existe **o no es suyo**, sin distinguir.
- Capacidad `notification:read` en el mapa de roles, para los cuatro.

### 9. Cómo se ve que anda

El paso 8 de `scripts/smoke-test.sh` (solo lectura) falla si hay filas pendientes con más de 5
minutos: un worker caído, o una fila que agotó sus intentos, se ve en el despliegue siguiente.
`scripts/verify-notification-outbox.sh` muestra el detalle (contenedor, logs, pendientes con
antigüedad, intentos y último error) y aplica el mismo criterio.

## Consecuencias

- Los avisos del responsable aparecen en la misma respuesta; los de la audiencia, a los pocos
  segundos. Un worker caído demora los avisos de la audiencia, no los pierde.
- **Una API comprometida podría marcar filas de la bandeja como procesadas** (la policy de
  organización permite `UPDATE`). No se mitiga hoy: el daño es que no se envíen avisos, no que se
  filtren datos. Se puede cerrar más adelante con permisos por columna.
- Las migraciones con una FK hacia `task` declaran la FK dentro del `CREATE TABLE`. Desde la `0015`
  un `ALTER TABLE ... ADD CONSTRAINT` falla con `42501`: el escaneo de validación lee `task` como
  `app_owner`, bajo policies que llaman a funciones cuyo `EXECUTE` `app_owner` no tiene a
  propósito. Vale para toda tabla futura (`attachment`, `task_acknowledgement`, ...).
- La API no reintenta un aviso directo que falle: si el insert falla, falla la mutación entera.
  Es la propiedad buscada.

## Alternativas descartadas

- **`EventEmitter` (ADR-009):** sin entrega garantizada.
- **Una función de base con `BYPASSRLS` que devuelva los miembros del proyecto** (ampliar la lista
  fija de `ensure-roles.sql`): sumaría superficie al único rol con `BYPASSRLS`, exigiría ampliar
  los tipos de retorno que admite el puente (hoy `boolean` o `setof uuid`; los ids de miembro son
  `text`) y un paso manual de despliegue.
- **Encolar en pg-boss desde la base:** ver el punto 3.
- **Avisar solo a quien el actor ve:** no avisa nunca cuando bloquea un operario asignado.

## Pendiente

- "Marcar todas como leídas": antes de la primera pantalla de avisos.
- Nombres de miembros en lote (ya anotado en el brief): los avisos llevan ids, no nombres.
- Push de la parte 2, sobre la misma tabla y el mismo patrón.
- Archivar o limpiar las filas procesadas de la bandeja, si llegan a pesar.
