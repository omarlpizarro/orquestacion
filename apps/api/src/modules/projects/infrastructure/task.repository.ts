import type { Tx } from '@orq/db';
import { sql } from 'drizzle-orm';

export interface ProjectRow {
  id: string;
  siteId: string | null;
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
 * `taskOutputSchema` (que exige ISO estricto) lo valide.
 */
function toIsoOrNull(value: string | null): string | null {
  return value === null ? null : new Date(value).toISOString();
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
    createdAt: toIsoOrNull(row.created_at) ?? row.created_at,
  };
}

export async function findProjectForTenant(
  tx: Tx,
  params: { organizationId: string; projectId: string },
): Promise<ProjectRow | null> {
  const result = await tx.execute<{ id: string; site_id: string | null }>(sql`
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
