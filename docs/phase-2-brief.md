Inicio de fase 2: proyectos, tareas y transiciones de estado.

Como documento del repo conviene que empiece con dos líneas de contexto: qué fase es, de qué fecha, y que este documento manda sobre cualquier interpretación distinta mientras dure la fase. Cuando la fase termine, lo cerrás con una línea de estado ("completada, ver PRs #x a #y") en vez de borrarlo: es el registro de qué se decidió y por qué.

Decisiones que se cierran ahora (actualizá docs/data-model.md sección de decisiones abiertas y escribí los ADR que correspondan):

Jerarquía de tareas: se mantiene path con ltree en el esquema, pero la capa de dominio limita la profundidad a tres niveles. El límite es una constante, no una restricción de base.
La idempotencia se adelanta a esta fase. Todo endpoint de escritura acepta client_mutation_id, lo registra en mutation_log y devuelve el resultado anterior si ya lo vio. Mismo criterio que usamos para adelantar roles y RLS: es caro de retrofitear.
Los eventos de dominio se emiten desde esta fase aunque todavía no haya consumidores.

Orden de trabajo. No lo alteres y no paralelices hasta que te lo diga.

PR 1: slice de referencia. Implementá únicamente create-task, de punta a punta: contrato en packages/contracts, handler, controller, migración, evento de dominio, test unitario y test de integración con Testcontainers. Cuando esté, lo revisamos juntos y lo congelamos como plantilla. Todos los slices posteriores copian su forma. No avances al PR 2 hasta que yo apruebe este.

PR 2: máquina de estados. Código de dominio puro en domain/, con tabla explícita de transiciones permitidas, qué rol puede hacer cada una y qué efecto tiene. Tests exhaustivos, sin endpoints. Tres reglas fijas:

Pasar a blocked exige motivo: crea un task_update de tipo block_report en la misma transacción.
Pasar a done setea actual_end_at con hora de servidor, nunca con lo que mande el cliente.
cancelled es terminal y queda fuera de los KPIs de cumplimiento.

PR 3 en adelante: el resto de los slices, un slice por PR. Acá sí se puede trabajar en paralelo.

Alcance de la fase. Entra: CRUD de proyectos, CRUD de tareas y subtareas, asignación de responsables, transiciones de estado, vista "Mi Día", notificaciones básicas, audit trail activo sobre task y project, y un dashboard web mínimo.

No entra, aunque el modelado lo sugiera: dependencias entre tareas, hitos, reprogramación en cascada, instanciación de plantillas SOP, campos personalizados, Gantt y analytics. Si aparecen en un PR es scope creep, aunque el código esté bien.

Alcance por sitio, pendiente y explícito: `task:create` (agregado en PR 1) no consulta `member_site_access` — hoy un manager puede crear tareas en proyectos de cualquier sitio de la organización, no solo los que tiene asignados. Es un agujero de autorización real, no un detalle. Tiene que resolverse antes de cerrar la fase, junto con cualquier otra capacidad de `manager` que la revisión de cada PR identifique con el mismo problema — no alcanza con resolverlo solo para `task:create` si aparecen más.

El mismo hueco cruza la máquina de estados (PR 2): `resolveTaskStatusTransition` (`apps/api/src/modules/projects/domain/task-status-transitions.ts`) hoy deja transicionar a un `operator` solo si es el `assignee_member_id` de la tarea, así que no puede bloquear una tarea todavía sin asignar — que es justamente el caso de campo que motivó agregar `pending → blocked`. Cuando se implemente el alcance por sitio, la regla para `operator` tiene que evaluar "es el asignado, o la tarea es de un sitio al que tiene acceso y no tiene asignado", no solo "es el asignado".

Decisión pendiente sobre la máquina de estados: si hace falta `in_review → blocked` con motivo. Hoy un problema detectado en revisión solo puede volver a `in_progress`, y solo lo puede hacer gerencia (`MANAGEMENT_ROLES`) — no hay un camino directo a `blocked` desde `in_review`. Evaluar antes de cerrar la fase si ese caso aparece en la práctica y, si aparece, si conviene agregarlo o si volver primero a `in_progress` alcanza.

Requisitos transversales de cada slice. Ninguno se da por terminado sin esto:

Acepta client_mutation_id.
Verifica version para concurrencia optimista donde corresponda.
Emite su evento de dominio (TaskCreated, TaskAssigned, TaskStatusChanged, TaskRescheduled).
Corre bajo el contexto de transacción con app.current_org, app.current_member y app.request_id seteados.
Tiene test de integración contra Postgres real, ejecutando las aserciones con la misma identidad de conexión que usa la app en producción, no con el dueño del esquema.
No importa esquema Drizzle ni tablas de otro módulo.

Zonas horarias. El usuario elige "martes a las 8" en la hora del sitio y eso se guarda en UTC. Resolvelo explícitamente en el slice de referencia, con test, porque si sale mal ahí sale mal en todo el sistema.

Seed y rendimiento. Armá un seed de volumen realista: 50 organizaciones con unas 500 tareas cada una, repartidas entre las industrias objetivo. La consulta de "Mi Día" necesita un test que afirme que el plan de ejecución usa el índice compuesto (organization_id, assignee_member_id, status, planned_end_at). Verificarlo con diez filas no prueba nada. Mismo tratamiento para (organization_id, project_id, parent_task_id), que necesita findLastSiblingPosition (create-task, PR 1) — falta desde ese PR, se agrega acá en vez de en su propio PR para no crear una migración que solo agrega un índice.

Cómo trabajar. Un slice por PR; si un PR toca domain/ más cuatro features, dividilo. Ante cualquier ambigüedad, pará y planteámela con las opciones y su evidencia, como hiciste con el singular/plural y con las peer dependencies. Si una decisión de la tabla de stack está bloqueada por un hecho verificable, decilo: eso no es redebatir, es lo que quiero que hagas.

Empezá por el PR 1 y avisame cuando esté para revisar.

Finalment
La fase 2 está completa cuando: existe un proyecto con tareas y subtareas creadas desde la API, un operativo ve sus tareas del día en móvil y puede cambiarles el estado, un bloqueo genera novedad y notificación, el audit trail registra todos esos cambios, el test de aislamiento de tenant pasa con la identidad de producción, la consulta de "Mi Día" usa el índice bajo el seed de volumen, el scoping por sitio (member_site_access) se aplica a todas las capacidades de manager que lo necesitan, y pnpm check && pnpm test está en verde.