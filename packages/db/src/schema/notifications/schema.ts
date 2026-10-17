import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { standardColumns } from '../../columns.js';
import { task } from '../projects/schema.js';

/**
 * Un aviso para una persona (docs/data-model.md, "Notificaciones", ADR-019). En la
 * parte 1 solo existe el canal `inapp`: la fila ES el aviso, así que nace
 * `delivered`. Las columnas de los otros canales (`scheduled_for`,
 * `provider_message_id`, `error`) ya están para que el push de la parte 2 no
 * necesite una migración.
 *
 * `task_id` y `project_id` son nulables (un aviso de la organización no cuelga de una
 * tarea), pero cuando vienen, vienen los dos y la FK compuesta impide que difieran de
 * los de la tarea (mismo criterio que `task_update`, ADR-017). Con las dos columnas, la
 * tabla recibe las policies por proyecto de `app_apply_project_policies()`: quien
 * perdió acceso al proyecto deja de ver sus avisos viejos.
 */
export const notification = pgTable(
  'notification',
  {
    ...standardColumns(),
    recipientMemberId: text('recipient_member_id').notNull(),
    taskId: uuid('task_id'),
    projectId: uuid('project_id'),
    templateKey: text('template_key').notNull(),
    channel: text('channel').notNull(),
    payload: jsonb('payload').notNull().default({}),
    status: text('status').notNull().default('queued'),
    dedupeKey: text('dedupe_key'),
    scheduledFor: timestamp('scheduled_for', { withTimezone: true, mode: 'string' }),
    sentAt: timestamp('sent_at', { withTimezone: true, mode: 'string' }),
    readAt: timestamp('read_at', { withTimezone: true, mode: 'string' }),
    providerMessageId: text('provider_message_id'),
    error: text('error'),
  },
  (table) => [
    foreignKey({
      columns: [table.organizationId, table.taskId],
      foreignColumns: [task.organizationId, task.id],
    }),
    foreignKey({
      columns: [table.organizationId, table.taskId, table.projectId],
      foreignColumns: [task.organizationId, task.id, task.projectId],
    }),
    // `dedupe_key` evita el aviso duplicado (un reintento, o el mismo aviso armado por
    // dos caminos). `NULL` no choca consigo mismo: un aviso sin clave no se deduplica.
    unique('notification_org_dedupe_key_unique').on(table.organizationId, table.dedupeKey),
    // Listado de una persona, el más nuevo primero. Se ordena por `id` (UUIDv7, ordenable
    // por tiempo): el cursor es el último id, exacto y sin perder precisión de timestamps.
    index('notification_org_recipient_id_idx').on(
      table.organizationId,
      table.recipientMemberId,
      table.id.desc(),
    ),
    // Contador de no leídos.
    index('notification_org_recipient_unread_idx')
      .on(table.organizationId, table.recipientMemberId)
      .where(sql`${table.readAt} is null and ${table.deletedAt} is null`),
    check(
      'notification_channel_check',
      sql`${table.channel} in ('inapp','push','email','whatsapp')`,
    ),
    check(
      'notification_status_check',
      sql`${table.status} in ('queued','sent','delivered','failed','suppressed')`,
    ),
    check(
      'notification_project_task_check',
      sql`${table.taskId} is null or ${table.projectId} is not null`,
    ),
  ],
);

/**
 * Bandeja de pendientes transaccional del módulo `notifications` (ADR-019). La
 * mutación que necesita un aviso cuya audiencia ella misma no puede calcular (quien
 * bloquea puede ser un operario "solo asignado", que no ve `project_member`) inserta
 * una fila acá, en la misma transacción. El worker la recorre en contexto de sistema,
 * recalcula todo desde la base a partir de los ids, crea los avisos y marca
 * `processed_at`. La API nunca confía su resultado a la memoria del proceso.
 *
 * Solo lleva ids: el worker no cree nada más de lo que dice la fila. `kind` es un
 * conjunto abierto que despacha el código (hoy `task.blocked`), sin `CHECK`: un tipo
 * nuevo no debería exigir el ritual de ampliar una constraint, y el worker deja
 * registrado como error el que no conoce.
 *
 * Las filas procesadas no se borran (regla dura 9): crece una fila por aviso con
 * audiencia calculada, y es chica.
 */
export const notificationOutbox = pgTable(
  'notification_outbox',
  {
    ...standardColumns(),
    kind: text('kind').notNull(),
    entityId: uuid('entity_id').notNull(),
    processedAt: timestamp('processed_at', { withTimezone: true, mode: 'string' }),
    attempts: integer('attempts').notNull().default(0),
    lastAttemptAt: timestamp('last_attempt_at', { withTimezone: true, mode: 'string' }),
    lastError: text('last_error'),
  },
  (table) => [
    // Encolar dos veces lo mismo (un reintento) no duplica el trabajo.
    unique('notification_outbox_org_kind_entity_unique').on(
      table.organizationId,
      table.kind,
      table.entityId,
    ),
    // Los pendientes: el conjunto que el worker recorre es chico y este índice lo acota.
    index('notification_outbox_org_pending_idx')
      .on(table.organizationId, table.createdAt)
      .where(sql`${table.processedAt} is null`),
    check('notification_outbox_attempts_check', sql`${table.attempts} >= 0`),
  ],
);
