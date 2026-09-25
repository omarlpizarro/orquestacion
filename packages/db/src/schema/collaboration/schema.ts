import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { standardColumns } from '../../columns.js';
import { task } from '../projects/schema.js';

/**
 * `task_update` es lo que la gente escribe (RF-E2), no lo que el sistema
 * registra solo (`audit_log`, RF-E4): se edita y se puede borrar (lógicamente,
 * `deleted_at`). Columnas estándar (CLAUDE.md §6) como cualquier otra tabla de
 * negocio — `created_by_member_id` es `NOT NULL`; las entradas de tipo
 * `system` sin un miembro humano detrás quedan diferidas (docs/data-model.md,
 * decisiones abiertas #7) hasta que exista la fase que de verdad las escribe.
 *
 * `edited_at` es distinto de `updated_at`: marca cuándo el autor editó el
 * texto de su propia novedad, no cualquier cambio de fila (el trigger de
 * `version` bumpea `updated_at` en cualquier `UPDATE`, incluido el soft
 * delete).
 */
export const taskUpdate = pgTable(
  'task_update',
  {
    ...standardColumns(),
    taskId: uuid('task_id').notNull(),
    kind: text('kind').notNull(),
    body: text('body'),
    metadata: jsonb('metadata').notNull().default({}),
    editedAt: timestamp('edited_at', { withTimezone: true, mode: 'string' }),
  },
  (table) => [
    foreignKey({
      columns: [table.organizationId, table.taskId],
      foreignColumns: [task.organizationId, task.id],
    }),
    // docs/data-model.md, sección "Índices, rendimiento y crecimiento":
    // sirve a la bitácora de una tarea (más reciente primero).
    index('task_update_org_task_created_idx').on(
      table.organizationId,
      table.taskId,
      table.createdAt.desc(),
    ),
    // `reopen` se agrega en la migración 0007 (change-task-status, ADR-012):
    // igual que `block_report`, es el `kind` del `task_update` que deja
    // constancia del motivo de una transición que lo exige — acá, reabrir
    // una tarea `done`.
    check(
      'task_update_kind_check',
      sql`${table.kind} in ('comment','status_change','block_report','evidence','system','reopen')`,
    ),
  ],
);
