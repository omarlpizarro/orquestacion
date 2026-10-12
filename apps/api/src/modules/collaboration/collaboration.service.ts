import { Injectable } from '@nestjs/common';
import type { Tx } from '@orq/db';
import { sql } from 'drizzle-orm';

/** `task_update_kind_check`, `0006_collaboration.sql` + `0007_task_update_reopen_kind.sql`. */
export type TaskUpdateKind =
  | 'comment'
  | 'status_change'
  | 'block_report'
  | 'evidence'
  | 'system'
  | 'reopen';

export interface CreateTaskUpdateParams {
  id: string;
  organizationId: string;
  createdByMemberId: string;
  taskId: string;
  kind: TaskUpdateKind;
  body: string | null;
  metadata?: Record<string, unknown>;
}

export interface TaskUpdateRow {
  id: string;
  taskId: string;
  kind: TaskUpdateKind;
  body: string | null;
  createdAt: string;
}

/** Una novedad completa, tal como la lee `projects` para mostrar la bitácora de una tarea. */
export interface TaskUpdateDetail {
  id: string;
  taskId: string;
  kind: TaskUpdateKind;
  body: string | null;
  metadata: Record<string, unknown>;
  createdByMemberId: string;
  createdAt: string;
}

interface TaskUpdateDetailSql extends Record<string, unknown> {
  id: string;
  task_id: string;
  kind: TaskUpdateKind;
  body: string | null;
  metadata: Record<string, unknown> | null;
  created_by_member_id: string;
  created_at: string;
}

interface TaskUpdateRowSql extends Record<string, unknown> {
  id: string;
  task_id: string;
  kind: TaskUpdateKind;
  body: string | null;
  created_at: string;
}

/**
 * Único punto por el que otro módulo escribe en `task_update` (CLAUDE.md
 * §5): `projects` necesita dejar constancia del motivo de un bloqueo o de
 * una reapertura (ADR-012) en la misma transacción que cambia `task.status`,
 * pero no puede insertar directo en una tabla que no es suya. El `id` lo
 * genera quien llama (igual que `insertTask` en `projects`, ver
 * `task.repository.ts`): no es un endpoint propio con un `client_mutation_id`
 * del cliente final, así que no hay un id que venga de afuera — la mutación
 * que sí lo tiene es la del módulo que llama, y este insert es su efecto
 * secundario dentro de la misma transacción.
 */
@Injectable()
export class CollaborationService {
  async createTaskUpdate(tx: Tx, params: CreateTaskUpdateParams): Promise<TaskUpdateRow> {
    const result = await tx.execute<TaskUpdateRowSql>(sql`
      insert into task_update (
        id, organization_id, created_by_member_id, task_id, kind, body, metadata
      ) values (
        ${params.id}, ${params.organizationId}, ${params.createdByMemberId},
        ${params.taskId}, ${params.kind}, ${params.body},
        ${JSON.stringify(params.metadata ?? {})}
      )
      returning id, task_id, kind, body, created_at
    `);
    const row = result.rows[0];
    if (!row) throw new Error('createTaskUpdate no devolvió ninguna fila');
    return {
      id: row.id,
      taskId: row.task_id,
      kind: row.kind,
      body: row.body,
      createdAt: row.created_at,
    };
  }

  /**
   * Las novedades de una tarea, de la más vieja a la más nueva. Si hay más que
   * `limit`, quedan las más recientes y `truncated` es `true`. Lo que quien lee no
   * puede ver (ADR-017: acceso completo al proyecto, o la tarea asignada) lo filtra
   * RLS; las borradas (`deleted_at`) no salen. Índice
   * `(organization_id, task_id, created_at DESC)`.
   */
  async listTaskUpdates(
    tx: Tx,
    params: { organizationId: string; taskId: string; limit: number },
  ): Promise<{ updates: TaskUpdateDetail[]; truncated: boolean }> {
    const result = await tx.execute<TaskUpdateDetailSql>(sql`
      select id, task_id, kind, body, metadata, created_by_member_id, created_at
        from task_update
       where organization_id = ${params.organizationId}
         and task_id = ${params.taskId}
         and deleted_at is null
       order by created_at desc, id desc
       limit ${params.limit + 1}
    `);
    const truncated = result.rows.length > params.limit;
    const newest = result.rows.slice(0, params.limit).reverse();
    return {
      truncated,
      updates: newest.map((row) => ({
        id: row.id,
        taskId: row.task_id,
        kind: row.kind,
        body: row.body,
        metadata: row.metadata ?? {},
        createdByMemberId: row.created_by_member_id,
        // `timestamptz` llega como texto nativo de Postgres (ver `task.repository.ts`).
        createdAt: new Date(row.created_at).toISOString(),
      })),
    };
  }
}
