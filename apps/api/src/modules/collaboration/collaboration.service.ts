import { Injectable } from '@nestjs/common';
import type { Tx } from '@orq/db';
import { sql } from 'drizzle-orm';

/** `task_update_kind_check`, `0006_collaboration.sql`. */
export type TaskUpdateKind = 'comment' | 'status_change' | 'block_report' | 'evidence' | 'system';

export interface CreateTaskUpdateParams {
  id: string;
  organizationId: string;
  createdByMemberId: string;
  taskId: string;
  kind: TaskUpdateKind;
  body: string | null;
}

export interface TaskUpdateRow {
  id: string;
  taskId: string;
  kind: TaskUpdateKind;
  body: string | null;
  createdAt: string;
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
        id, organization_id, created_by_member_id, task_id, kind, body
      ) values (
        ${params.id}, ${params.organizationId}, ${params.createdByMemberId},
        ${params.taskId}, ${params.kind}, ${params.body}
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
}
