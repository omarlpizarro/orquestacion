import type { Tx } from '@orq/db';
import { sql } from 'drizzle-orm';

export interface ProjectRow {
  id: string;
  siteId: string;
  visibility: string;
  code: string;
  name: string;
  description: string | null;
  status: string;
  createdByMemberId: string;
  version: number;
  createdAt: string;
  /** Acceso completo de quien abrió la transacción (ADR-017 §1); `false` es "solo asignado". */
  fullAccess: boolean;
}

interface ProjectRowSql extends Record<string, unknown> {
  id: string;
  site_id: string;
  visibility: string;
  code: string;
  name: string;
  description: string | null;
  status: string;
  created_by_member_id: string;
  version: number;
  created_at: string;
  full_access: boolean;
}

/**
 * `full_access` sale de `app_full_access_project_ids()` como subconsulta no
 * correlacionada (se calcula una vez por sentencia, no por fila): la misma
 * implementación que usan las policies, nunca una copia en TypeScript
 * (ADR-017 §3). Lee con la identidad de `tx`.
 */
const projectColumns = sql`
  p.id, p.site_id, p.visibility, p.code, p.name, p.description, p.status,
  p.created_by_member_id, p.version, p.created_at,
  (p.id IN (SELECT app_full_access_project_ids())) AS full_access
`;

/** Verificado en `task.repository.ts`: `timestamptz` llega como texto nativo de Postgres. */
function toProjectRow(row: ProjectRowSql): ProjectRow {
  return {
    id: row.id,
    siteId: row.site_id,
    visibility: row.visibility,
    code: row.code,
    name: row.name,
    description: row.description,
    status: row.status,
    createdByMemberId: row.created_by_member_id,
    version: row.version,
    createdAt: new Date(row.created_at).toISOString(),
    fullAccess: row.full_access,
  };
}

/** `null` si no existe o si RLS no deja verlo: para quien pregunta es lo mismo (ADR-017 §6). */
export async function findProjectById(
  tx: Tx,
  params: { organizationId: string; projectId: string },
): Promise<ProjectRow | null> {
  const result = await tx.execute<ProjectRowSql>(sql`
    select ${projectColumns}
      from project p
     where p.organization_id = ${params.organizationId}
       and p.id = ${params.projectId}
       and p.deleted_at is null
  `);
  const row = result.rows[0];
  return row ? toProjectRow(row) : null;
}

export async function listProjects(
  tx: Tx,
  params: { organizationId: string; limit: number },
): Promise<ProjectRow[]> {
  const result = await tx.execute<ProjectRowSql>(sql`
    select ${projectColumns}
      from project p
     where p.organization_id = ${params.organizationId}
       and p.deleted_at is null
     order by p.created_at desc, p.id desc
     limit ${params.limit}
  `);
  return result.rows.map(toProjectRow);
}

export interface InsertProjectParams {
  id: string;
  organizationId: string;
  createdByMemberId: string;
  siteId: string;
  code: string;
  name: string;
  description: string | null;
  visibility: 'reserved' | 'site';
}

/**
 * Sin `RETURNING` y sin `created_at` ni `version`: la adenda del ADR-017 depende
 * de que vengan del default de la base. El `RETURNING` además falla —la función
 * de acceso es `STABLE` y no ve la fila de su propia sentencia—; la fila se lee
 * con un `SELECT` aparte, después de insertar al creador como miembro.
 */
export async function insertProject(tx: Tx, params: InsertProjectParams): Promise<void> {
  await tx.execute(sql`
    insert into project
      (id, organization_id, created_by_member_id, site_id, code, name, description, visibility)
    values (
      ${params.id}, ${params.organizationId}, ${params.createdByMemberId}, ${params.siteId},
      ${params.code}, ${params.name}, ${params.description}, ${params.visibility}
    )
  `);
}

/** `false` si la versión ya no coincide (alguien ganó la carrera). */
export async function updateProjectVisibility(
  tx: Tx,
  params: {
    organizationId: string;
    projectId: string;
    visibility: 'reserved' | 'site';
    expectedVersion: number;
  },
): Promise<boolean> {
  const result = await tx.execute(sql`
    update project
       set visibility = ${params.visibility}
     where organization_id = ${params.organizationId}
       and id = ${params.projectId}
       and version = ${params.expectedVersion}
       and deleted_at is null
  `);
  return (result.rowCount ?? 0) > 0;
}

export async function isActiveProjectMember(
  tx: Tx,
  params: { organizationId: string; projectId: string; memberId: string },
): Promise<boolean> {
  const result = await tx.execute<{ id: string }>(sql`
    select id from project_member
     where organization_id = ${params.organizationId}
       and project_id = ${params.projectId}
       and member_id = ${params.memberId}
       and deleted_at is null
  `);
  return result.rows.length > 0;
}

/**
 * Los miembros explícitos (no borrados) de un proyecto. Lee con la identidad de `tx`: quien no
 * tiene acceso completo no ve `project_member` (ADR-017) y recibe una lista vacía, que es el lado
 * seguro; el contexto de sistema del worker la ve entera.
 */
export async function listActiveProjectMemberIds(
  tx: Tx,
  params: { organizationId: string; projectId: string },
): Promise<string[]> {
  const result = await tx.execute<{ member_id: string }>(sql`
    select member_id from project_member
     where organization_id = ${params.organizationId}
       and project_id = ${params.projectId}
       and deleted_at is null
     order by member_id
  `);
  return result.rows.map((row) => row.member_id);
}

/**
 * `ON CONFLICT DO NOTHING` sobre el índice único parcial de miembros activos
 * (`project_member_org_project_member_active_uidx`): agregar a quien ya es
 * miembro no es un error ni duplica la fila, también si dos pedidos distintos lo
 * agregan a la vez.
 */
export async function insertProjectMember(
  tx: Tx,
  params: {
    id: string;
    organizationId: string;
    createdByMemberId: string;
    projectId: string;
    memberId: string;
  },
): Promise<void> {
  await tx.execute(sql`
    insert into project_member (id, organization_id, created_by_member_id, project_id, member_id)
    values (
      ${params.id}, ${params.organizationId}, ${params.createdByMemberId},
      ${params.projectId}, ${params.memberId}
    )
    on conflict (organization_id, project_id, member_id) where deleted_at is null do nothing
  `);
}

/** Regla dura 9: se marca `deleted_at`, nunca se borra la fila. */
export async function softDeleteProjectMember(
  tx: Tx,
  params: { organizationId: string; projectId: string; memberId: string },
): Promise<boolean> {
  const result = await tx.execute(sql`
    update project_member
       set deleted_at = now()
     where organization_id = ${params.organizationId}
       and project_id = ${params.projectId}
       and member_id = ${params.memberId}
       and deleted_at is null
  `);
  return (result.rowCount ?? 0) > 0;
}

/**
 * Tareas no borradas, en cualquier estado, asignadas a este miembro en el
 * proyecto: las que le dan el nivel "solo asignado" (ADR-017 §1). Quitarlo no
 * las toca. Se cuenta antes de quitarlo, con el acceso de quien lo quita.
 */
export async function countAssignedTasks(
  tx: Tx,
  params: { organizationId: string; projectId: string; memberId: string },
): Promise<number> {
  const result = await tx.execute<{ count: number }>(sql`
    select count(*)::int as count from task
     where organization_id = ${params.organizationId}
       and project_id = ${params.projectId}
       and assignee_member_id = ${params.memberId}
       and deleted_at is null
  `);
  return result.rows[0]?.count ?? 0;
}
