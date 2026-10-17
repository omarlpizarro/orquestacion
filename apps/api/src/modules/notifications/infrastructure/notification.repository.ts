import type { NotificationPayload, NotificationTemplateKey } from '@orq/contracts';
import type { Tx } from '@orq/db';
import { sql } from 'drizzle-orm';

export interface NotificationRow {
  id: string;
  templateKey: NotificationTemplateKey;
  taskId: string | null;
  projectId: string | null;
  payload: NotificationPayload;
  createdAt: string;
  readAt: string | null;
}

interface NotificationRowSql extends Record<string, unknown> {
  id: string;
  template_key: NotificationTemplateKey;
  task_id: string | null;
  project_id: string | null;
  payload: NotificationPayload;
  created_at: string;
  read_at: string | null;
}

const SELECT_COLUMNS = sql`id, template_key, task_id, project_id, payload, created_at, read_at`;

/** `timestamptz` llega como texto nativo de Postgres (ver `task.repository.ts`). */
function toNotificationRow(row: NotificationRowSql): NotificationRow {
  return {
    id: row.id,
    templateKey: row.template_key,
    taskId: row.task_id,
    projectId: row.project_id,
    payload: row.payload,
    createdAt: new Date(row.created_at).toISOString(),
    readAt: row.read_at ? new Date(row.read_at).toISOString() : null,
  };
}

/**
 * Los avisos de `memberId`, del más nuevo al más viejo. `recipient_member_id` se filtra
 * también acá aunque la base ya lo impone con RLS: es lo que hace usar el índice
 * `(organization_id, recipient_member_id, id DESC)`. `afterId` es el cursor: los anteriores
 * a ese id.
 */
export async function listNotifications(
  tx: Tx,
  params: {
    organizationId: string;
    memberId: string;
    unreadOnly: boolean;
    afterId: string | null;
    limit: number;
  },
): Promise<NotificationRow[]> {
  const result = await tx.execute<NotificationRowSql>(sql`
    select ${SELECT_COLUMNS}
      from notification
     where organization_id = ${params.organizationId}
       and recipient_member_id = ${params.memberId}
       and deleted_at is null
       ${params.unreadOnly ? sql`and read_at is null` : sql``}
       ${params.afterId ? sql`and id < ${params.afterId}` : sql``}
     order by id desc
     limit ${params.limit}
  `);
  return result.rows.map(toNotificationRow);
}

/** Índice parcial `notification_org_recipient_unread_idx`. */
export async function countUnreadNotifications(
  tx: Tx,
  params: { organizationId: string; memberId: string },
): Promise<number> {
  const result = await tx.execute<{ count: number }>(sql`
    select count(*)::int as count
      from notification
     where organization_id = ${params.organizationId}
       and recipient_member_id = ${params.memberId}
       and read_at is null
       and deleted_at is null
  `);
  return result.rows[0]?.count ?? 0;
}

export async function findNotification(
  tx: Tx,
  params: { organizationId: string; memberId: string; notificationId: string },
): Promise<NotificationRow | null> {
  const result = await tx.execute<NotificationRowSql>(sql`
    select ${SELECT_COLUMNS}
      from notification
     where organization_id = ${params.organizationId}
       and id = ${params.notificationId}
       and recipient_member_id = ${params.memberId}
       and deleted_at is null
  `);
  const row = result.rows[0];
  return row ? toNotificationRow(row) : null;
}

/**
 * Marca como leído. `read_at is null` en el `WHERE`: uno ya leído no se toca (conserva su
 * `read_at` y su `version`), y la función devuelve `null`, que el llamador resuelve leyéndolo.
 */
export async function markNotificationRead(
  tx: Tx,
  params: { organizationId: string; memberId: string; notificationId: string },
): Promise<NotificationRow | null> {
  const result = await tx.execute<NotificationRowSql>(sql`
    update notification
       set read_at = now()
     where organization_id = ${params.organizationId}
       and id = ${params.notificationId}
       and recipient_member_id = ${params.memberId}
       and read_at is null
       and deleted_at is null
    returning ${SELECT_COLUMNS}
  `);
  const row = result.rows[0];
  return row ? toNotificationRow(row) : null;
}

export interface InsertNotificationParams {
  id: string;
  organizationId: string;
  createdByMemberId: string;
  recipientMemberId: string;
  taskId: string;
  projectId: string;
  templateKey: NotificationTemplateKey;
  payload: NotificationPayload;
  dedupeKey: string;
}

/**
 * El aviso de OTRA persona: **sin `RETURNING`**, porque la policy de lectura por destinatario
 * se evaluaría sobre una fila que no es de quien inserta y rechazaría el insert (ADR-019).
 * `ON CONFLICT DO NOTHING` sobre `(organization_id, dedupe_key)`: el mismo aviso armado dos
 * veces es uno. En la parte 1 el único canal es `inapp`, y la fila ES el aviso: nace entregada.
 */
export async function insertNotification(tx: Tx, params: InsertNotificationParams): Promise<void> {
  await tx.execute(sql`
    insert into notification (
      id, organization_id, created_by_member_id, recipient_member_id, task_id, project_id,
      template_key, channel, payload, status, dedupe_key, sent_at
    ) values (
      ${params.id}, ${params.organizationId}, ${params.createdByMemberId},
      ${params.recipientMemberId}, ${params.taskId}, ${params.projectId},
      ${params.templateKey}, 'inapp', ${JSON.stringify(params.payload)}::jsonb, 'delivered',
      ${params.dedupeKey}, now()
    )
    on conflict do nothing
  `);
}

/** Encolar dos veces lo mismo (un reintento) no duplica la fila: `UNIQUE (organization_id, kind, entity_id)`. */
export async function insertOutboxEntry(
  tx: Tx,
  params: {
    id: string;
    organizationId: string;
    createdByMemberId: string;
    kind: string;
    entityId: string;
  },
): Promise<void> {
  await tx.execute(sql`
    insert into notification_outbox (id, organization_id, created_by_member_id, kind, entity_id)
    values (${params.id}, ${params.organizationId}, ${params.createdByMemberId},
            ${params.kind}, ${params.entityId})
    on conflict do nothing
  `);
}
