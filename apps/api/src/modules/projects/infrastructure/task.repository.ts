import type { MyDaySection } from '@orq/contracts';
import type { Tx } from '@orq/db';
import { sql } from 'drizzle-orm';

export interface ProjectRow {
  id: string;
  /** `NOT NULL` desde ADR-013 (migración 0010). */
  siteId: string;
}

export interface ParentTaskRow {
  id: string;
  depth: number;
}

export interface TaskRow {
  id: string;
  organizationId: string;
  projectId: string;
  parentTaskId: string | null;
  /** `nlevel(path)`, no el `ltree` crudo — ver `taskOutputSchema.depth`. */
  depth: number;
  title: string;
  description: string | null;
  status: string;
  criticality: string;
  assigneeMemberId: string | null;
  plannedStartAt: string | null;
  plannedEndAt: string | null;
  isMilestone: boolean;
  ackRequired: boolean;
  position: string;
  version: number;
  createdAt: string;
}

interface TaskRowSql extends Record<string, unknown> {
  id: string;
  organization_id: string;
  project_id: string;
  parent_task_id: string | null;
  depth: number;
  title: string;
  description: string | null;
  status: string;
  criticality: string;
  assignee_member_id: string | null;
  planned_start_at: string | null;
  planned_end_at: string | null;
  is_milestone: boolean;
  ack_required: boolean;
  position: string;
  version: number;
  created_at: string;
}

/**
 * Verificado contra el driver, no supuesto: por default `pg` sí parsea
 * `timestamptz` a `Date` (`pg-types`, OID 1184 → `parseDate`), pero
 * `drizzle-orm/node-postgres` pisa ese parser a propósito — ver
 * `node_modules/drizzle-orm/node-postgres/session.js`,
 * `rawQueryConfig.types.getTypeParser`, que para `TIMESTAMPTZ`/
 * `TIMESTAMP`/`DATE`/`INTERVAL` (y sus variantes array) devuelve
 * `(val) => val` en vez de parsear. Por eso `tx.execute(sql\`...\`)`
 * entrega el texto nativo de Postgres (`2026-09-20 21:28:47.564719+00`),
 * nunca un `Date` — confirmado además a mano contra el harness
 * (`typeof row.created_at === 'string'`). `new Date(...)` lo entiende
 * igual, así que solo hace falta normalizar antes de que
 * `taskOutputSchema` (que exige ISO estricto) lo valide. Todo el resto del
 * código (comparaciones de fecha incluidas) trabaja sobre este único
 * formato — las comparaciones de fecha en sí las hace Postgres, comparando
 * `timestamptz` como lo que son, nunca como texto.
 */
function toIso(value: string): string {
  return new Date(value).toISOString();
}

function toIsoOrNull(value: string | null): string | null {
  return value === null ? null : toIso(value);
}

function mapTaskRow(row: TaskRowSql): TaskRow {
  return {
    id: row.id,
    organizationId: row.organization_id,
    projectId: row.project_id,
    parentTaskId: row.parent_task_id,
    depth: row.depth,
    title: row.title,
    description: row.description,
    status: row.status,
    criticality: row.criticality,
    assigneeMemberId: row.assignee_member_id,
    plannedStartAt: toIsoOrNull(row.planned_start_at),
    plannedEndAt: toIsoOrNull(row.planned_end_at),
    isMilestone: row.is_milestone,
    ackRequired: row.ack_required,
    position: row.position,
    version: row.version,
    createdAt: toIso(row.created_at),
  };
}

export async function findProjectForTenant(
  tx: Tx,
  params: { organizationId: string; projectId: string },
): Promise<ProjectRow | null> {
  const result = await tx.execute<{ id: string; site_id: string }>(sql`
    select id, site_id from project
    where id = ${params.projectId} and organization_id = ${params.organizationId}
  `);
  const row = result.rows[0];
  return row ? { id: row.id, siteId: row.site_id } : null;
}

export async function findParentTaskForTenant(
  tx: Tx,
  params: { organizationId: string; projectId: string; parentTaskId: string },
): Promise<ParentTaskRow | null> {
  const result = await tx.execute<{ id: string; depth: number }>(sql`
    select id, nlevel(path) as depth from task
    where id = ${params.parentTaskId}
      and organization_id = ${params.organizationId}
      and project_id = ${params.projectId}
  `);
  const row = result.rows[0];
  return row ? { id: row.id, depth: row.depth } : null;
}

export async function findLastSiblingPosition(
  tx: Tx,
  params: { organizationId: string; projectId: string; parentTaskId: string | null },
): Promise<string | null> {
  const result = await tx.execute<{ position: string | null }>(sql`
    select max(position) as position from task
    where organization_id = ${params.organizationId}
      and project_id = ${params.projectId}
      and parent_task_id ${params.parentTaskId === null ? sql`is null` : sql`= ${params.parentTaskId}`}
  `);
  return result.rows[0]?.position ?? null;
}

export interface InsertTaskParams {
  id: string;
  organizationId: string;
  createdByMemberId: string;
  projectId: string;
  parentTaskId: string | null;
  title: string;
  description: string | null;
  criticality: string;
  assigneeMemberId: string | null;
  plannedStartAtUtc: string | null;
  plannedEndAtUtc: string | null;
  isMilestone: boolean;
  ackRequired: boolean;
  position: string;
}

/**
 * `path` no se manda: lo llena `task_maintain_path()` (trigger de
 * `0005_projects.sql`) a partir de `parent_task_id`. `RETURNING *` porque
 * el trigger y los defaults de columna (`status`, `version`, `created_at`)
 * son la fuente de verdad, no lo que mandó el cliente — se le agrega
 * `nlevel(path) as depth` porque el `ltree` crudo no sale de esta capa
 * (ver `taskOutputSchema.depth`).
 */
export async function insertTask(tx: Tx, params: InsertTaskParams): Promise<TaskRow> {
  const result = await tx.execute<TaskRowSql>(sql`
    insert into task (
      id, organization_id, created_by_member_id, project_id, parent_task_id,
      title, description, criticality, assignee_member_id,
      planned_start_at, planned_end_at, is_milestone, ack_required, position
    ) values (
      ${params.id}, ${params.organizationId}, ${params.createdByMemberId}, ${params.projectId},
      ${params.parentTaskId}, ${params.title}, ${params.description}, ${params.criticality},
      ${params.assigneeMemberId}, ${params.plannedStartAtUtc}, ${params.plannedEndAtUtc},
      ${params.isMilestone}, ${params.ackRequired}, ${params.position}
    )
    returning *, nlevel(path) as depth
  `);
  const row = result.rows[0];
  if (!row) throw new Error('insertTask no devolvió ninguna fila');
  return mapTaskRow(row);
}

export async function findTaskById(
  tx: Tx,
  params: { organizationId: string; taskId: string },
): Promise<TaskRow | null> {
  const result = await tx.execute<TaskRowSql>(
    sql`select *, nlevel(path) as depth from task where id = ${params.taskId} and organization_id = ${params.organizationId}`,
  );
  const row = result.rows[0];
  return row ? mapTaskRow(row) : null;
}

export interface TaskWithSiteRow extends TaskRow {
  /** Sitio del proyecto de la tarea: `task` no lo tiene, vive en `project`. */
  siteId: string;
}

/**
 * Para el alcance por sitio: mismo `TaskRow` que `findTaskById` más el
 * `site_id` del proyecto. Join por la clave compuesta (`organization_id`,
 * `project_id`), así que nunca cruza organizaciones aunque RLS fallara.
 */
export async function findTaskWithSiteById(
  tx: Tx,
  params: { organizationId: string; taskId: string },
): Promise<TaskWithSiteRow | null> {
  const result = await tx.execute<TaskRowSql & { site_id: string }>(sql`
    select t.*, nlevel(t.path) as depth, p.site_id
    from task t
    join project p on p.id = t.project_id and p.organization_id = t.organization_id
    where t.id = ${params.taskId} and t.organization_id = ${params.organizationId}
  `);
  const row = result.rows[0];
  return row ? { ...mapTaskRow(row), siteId: row.site_id } : null;
}

export interface FindMyDayTaskRowsParams {
  organizationId: string;
  assigneeMemberId: string;
  todayStartUtc: string;
  todayEndUtc: string;
}

export interface MyDayTaskRow extends TaskRow {
  section: MyDaySection;
  isOverdue: boolean;
}

interface MyDayTaskRowSql extends TaskRowSql {
  section: MyDaySection;
  is_overdue: boolean;
}

function mapMyDayTaskRow(row: MyDayTaskRowSql): MyDayTaskRow {
  return { ...mapTaskRow(row), section: row.section, isOverdue: row.is_overdue };
}

/**
 * Qué tarea entra a "Mi Día" y en qué sección vive es una regla que se
 * escribe acá, en un solo lugar — antes vivía duplicada entre este `WHERE`
 * y `classifyMyDayTask` (dominio, en TypeScript), y las dos copias
 * terminaban desincronizándose (docs/phase-2-brief.md, "Mi Día"). No es
 * una invariante de escritura como la máquina de estados de `task.status`
 * (que sí vive en `domain/`, con tests exhaustivos, porque protege qué se
 * persiste): es una proyección de lectura, así que vive en la consulta que
 * la produce.
 *
 * La subconsulta filtra por organización, assignee, `deleted_at` y estado
 * (exactamente las columnas de `task_org_assignee_status_planned_end_idx`,
 * más `deleted_at` porque el índice es parcial `WHERE deleted_at IS NULL`)
 * y calcula `section` con un `CASE` — `null` para lo que no entra a
 * ninguna sección — e `is_overdue` como expresión aparte, independiente de
 * `section` (una tarea puede ser `blocked` y estar vencida a la vez). Toda
 * `in_progress` no vencida cae en `today` sin mirar sus fechas (si un
 * operario ya está haciendo algo, no puede desaparecer de Mi Día porque
 * estaba agendado para mañana — docs/phase-2-brief.md, "Mi Día"). La
 * consulta externa descarta lo que no clasificó (`section is not null`) y
 * ordena: primero por sección (vencidas, hoy, bloqueadas, sin fecha),
 * después por el criterio de cada una. El `CASE ... end` sin `else`
 * (evalúa `null` fuera de la sección que le corresponde) es el truco
 * estándar para que una clave de orden solo aplique dentro de su propio
 * grupo — un valor compartido no discrimina entre filas de otro grupo, y
 * el orden entre grupos ya lo definió la primera clave. `id` al final
 * como desempate determinístico: a diferencia de un `Array.prototype.sort`
 * en JS, Postgres no garantiza ningún orden estable entre filas empatadas.
 *
 * Exportada (no solo usada internamente) para que el test de rendimiento
 * (`test/my-day-performance.integration.spec.ts`) le anteponga `EXPLAIN` a
 * esta misma consulta, exacta — nunca a una copia que podría
 * desincronizarse de la real.
 */
export function buildMyDayTaskQuery(params: FindMyDayTaskRowsParams) {
  return sql`
    select * from (
      select *, nlevel(path) as depth,
        case
          when status = 'blocked' then 'blocked'
          when planned_end_at is not null and planned_end_at < now() then 'overdue'
          when status = 'in_progress' then 'today'
          when coalesce(planned_start_at, planned_end_at) < ${params.todayEndUtc}
            and coalesce(planned_end_at, planned_start_at) >= ${params.todayStartUtc}
            then 'today'
          when status = 'pending' and planned_start_at is null and planned_end_at is null
            then 'undated'
        end as section,
        (planned_end_at is not null and planned_end_at < now()) as is_overdue
      from task
      where organization_id = ${params.organizationId}
        and assignee_member_id = ${params.assigneeMemberId}
        and deleted_at is null
        and status not in ('done', 'cancelled')
    ) classified
    where section is not null
    order by
      case section
        when 'overdue' then 0
        when 'today' then 1
        when 'blocked' then 2
        when 'undated' then 3
      end,
      -- Criticidad: aplica a vencidas, bloqueadas y sin fecha; en "hoy" el
      -- orden es por coalesce(planned_start_at, planned_end_at), así que
      -- acá da null para esas filas y no participa del desempate.
      case when section <> 'today' then
        case criticality
          when 'critical' then 0
          when 'high' then 1
          when 'normal' then 2
          else 3
        end
      end,
      case section when 'today' then coalesce(planned_start_at, planned_end_at) end,
      case when section in ('overdue', 'blocked') then planned_end_at end,
      case section when 'undated' then created_at end,
      id
  `;
}

export async function findMyDayTaskRows(
  tx: Tx,
  params: FindMyDayTaskRowsParams,
): Promise<MyDayTaskRow[]> {
  const result = await tx.execute<MyDayTaskRowSql>(buildMyDayTaskQuery(params));
  return result.rows.map(mapMyDayTaskRow);
}

export interface UpdateTaskStatusParams {
  organizationId: string;
  taskId: string;
  /** Concurrencia optimista: el `UPDATE` solo pega si nadie más cambió la fila desde que el handler la leyó. */
  expectedVersion: number;
  toStatus: string;
  /** `TaskStatusTransition.setsActualEndAt`/`clearsActualEndAt` (ADR-012) — la hora la pone `now()` de Postgres, nunca el cliente. */
  setsActualEndAt: boolean;
  clearsActualEndAt: boolean;
}

/**
 * `version` no se manda en el `SET`: lo avanza `app_bump_version()` (trigger,
 * `0005_projects.sql`) en cada `UPDATE` exitoso, nunca la aplicación. Cero
 * filas devueltas significa que `version` ya no es `expectedVersion` — el
 * handler ya confirmó que la tarea existe antes de llegar acá (con un
 * `findTaskById` propio), así que acá un resultado vacío es siempre una
 * carrera de concurrencia, nunca "no existe".
 */
export async function updateTaskStatus(
  tx: Tx,
  params: UpdateTaskStatusParams,
): Promise<TaskRow | null> {
  const result = await tx.execute<TaskRowSql>(sql`
    update task
    set status = ${params.toStatus},
        actual_end_at = case
          when ${params.setsActualEndAt} then now()
          when ${params.clearsActualEndAt} then null
          else actual_end_at
        end
    where id = ${params.taskId}
      and organization_id = ${params.organizationId}
      and version = ${params.expectedVersion}
    returning *, nlevel(path) as depth
  `);
  const row = result.rows[0];
  return row ? mapTaskRow(row) : null;
}
