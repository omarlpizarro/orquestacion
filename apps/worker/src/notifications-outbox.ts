import {
  blockedDedupeKey,
  buildReasonPreview,
  type NotificationPayload,
  newId,
} from '@orq/contracts';
import type { Db, Tx } from '@orq/db';
import { withSystemScanTransaction, withSystemTransaction } from '@orq/db/system';
import { sql } from 'drizzle-orm';

/**
 * Procesa la bandeja de pendientes de `notification_outbox` (ADR-019): el worker arma los avisos
 * cuya audiencia la API no puede calcular, porque quien actúa puede ser un operario "solo
 * asignado" que no ve `project_member`. El patrón es el mismo que va a usar el push de la
 * parte 2: una fila en la misma transacción que el cambio, y un proceso aparte que la levanta.
 *
 * Las lecturas cruzan tablas de varios módulos (`task_update`, `task`, `project`,
 * `project_member`, `member_site_access`, `auth.member`) con SQL crudo y contexto de sistema.
 * Es una excepción deliberada a la regla de que un módulo no consulta tablas de otro (regla dura
 * 5), documentada en ADR-019: esto no es un módulo de la API sino su proyección de lectura en el
 * proceso privilegiado, y el cálculo de la audiencia queda escrito en un solo lugar.
 */
export const OUTBOX_KIND_TASK_BLOCKED = 'task.blocked';

export const OUTBOX_POLL_INTERVAL_MS = 5_000;
export const OUTBOX_BATCH_SIZE = 50;
/** Pasado este número de intentos fallidos la fila deja de reintentarse; sigue pendiente y a la vista. */
export const OUTBOX_MAX_ATTEMPTS = 10;
/** Espera entre reintentos: `min(intentos, 6) * 30 s`, así una falla persistente no se reintenta a ritmo de sondeo. */
export const OUTBOX_BACKOFF_STEP_SECONDS = 30;
const MAX_ERROR_LENGTH = 1_000;
const JOB = 'notifications.outbox';

interface OutboxEntry extends Record<string, unknown> {
  id: string;
  organization_id: string;
}

export interface OutboxRunSummary {
  /** Filas encontradas pendientes en esta vuelta. */
  found: number;
  /** Filas procesadas y marcadas. */
  processed: number;
  /** Avisos nuevos creados (los que ya existían por `dedupe_key` no cuentan). */
  notifications: number;
  /** Filas que otro worker ya había tomado. */
  skipped: number;
  failed: number;
}

/**
 * Una vuelta: busca los pendientes de todas las organizaciones y procesa cada uno en su propia
 * transacción. Una fila que falla no frena a las demás.
 */
export async function processNotificationOutbox(
  db: Db,
  requestId: string,
): Promise<OutboxRunSummary> {
  const summary: OutboxRunSummary = {
    found: 0,
    processed: 0,
    notifications: 0,
    skipped: 0,
    failed: 0,
  };

  // Lectura transversal, solo para localizar. No toma locks: el bloqueo es por fila, abajo.
  const entries = await withSystemScanTransaction(db, { job: JOB, requestId }, async (tx) => {
    const result = await tx.execute<OutboxEntry>(sql`
      select id, organization_id
        from notification_outbox
       where processed_at is null
         and deleted_at is null
         and attempts < ${OUTBOX_MAX_ATTEMPTS}
         and (last_attempt_at is null
              or last_attempt_at < now() - make_interval(
                   secs => least(attempts, 6) * ${OUTBOX_BACKOFF_STEP_SECONDS}))
       order by created_at, id
       limit ${OUTBOX_BATCH_SIZE}
    `);
    return result.rows;
  });
  summary.found = entries.length;

  for (const entry of entries) {
    try {
      const outcome = await processEntry(db, entry, requestId);
      if (outcome === 'skipped') {
        summary.skipped += 1;
      } else {
        summary.processed += 1;
        summary.notifications += outcome.notifications;
      }
    } catch (error) {
      summary.failed += 1;
      await recordFailure(db, entry, error, requestId);
    }
  }
  return summary;
}

/**
 * Una fila, una transacción (de sistema, de SU organización): toma la fila con
 * `FOR UPDATE SKIP LOCKED` (si otro worker la tiene, sigue de largo), arma los avisos y la marca
 * procesada. Si algo falla, todo se deshace y la fila queda pendiente.
 */
async function processEntry(
  db: Db,
  entry: OutboxEntry,
  requestId: string,
): Promise<'skipped' | { notifications: number }> {
  return withSystemTransaction(
    db,
    { organizationId: entry.organization_id, job: JOB, requestId },
    async (tx) => {
      const locked = await tx.execute<{ kind: string; entity_id: string }>(sql`
        select kind, entity_id
          from notification_outbox
         where id = ${entry.id}
           and organization_id = ${entry.organization_id}
           and processed_at is null
           for update skip locked
      `);
      const row = locked.rows[0];
      if (!row) return 'skipped';

      // No se confía en nada de la fila más allá de los ids: el tipo despacha y el resto se
      // recalcula desde la base.
      if (row.kind !== OUTBOX_KIND_TASK_BLOCKED) {
        throw new Error(`Tipo de pendiente desconocido: ${row.kind}`);
      }
      const notifications = await fanOutTaskBlocked(tx, {
        organizationId: entry.organization_id,
        taskUpdateId: row.entity_id,
      });

      await tx.execute(sql`
        update notification_outbox
           set processed_at = now()
         where id = ${entry.id} and organization_id = ${entry.organization_id}
      `);
      return { notifications };
    },
  );
}

interface BlockSourceRow extends Record<string, unknown> {
  kind: string;
  body: string | null;
  reporter: string;
  task_id: string;
  project_id: string;
  title: string;
  assignee_member_id: string | null;
  task_deleted_at: string | null;
  visibility: string;
  site_id: string;
  project_deleted_at: string | null;
}

/**
 * Los avisos de un bloqueo. Audiencia (docs/phase-2-brief.md, "Decisiones de notificaciones"):
 *  - los miembros explícitos del proyecto, el creador incluido;
 *  - si el proyecto es de sitio, los `manager` con acceso a ese sitio;
 *  - el responsable de la tarea;
 * menos quien bloqueó. `owner` y `director` solo si son miembros explícitos: nunca por ser
 * privilegiados, porque avisarle a quien no ve un proyecto reservado revelaría que existe.
 * Solo miembros que siguen en la organización. Devuelve cuántos avisos nuevos se crearon.
 */
async function fanOutTaskBlocked(
  tx: Tx,
  params: { organizationId: string; taskUpdateId: string },
): Promise<number> {
  const { organizationId, taskUpdateId } = params;

  const source = await tx.execute<BlockSourceRow>(sql`
    select tu.kind, tu.body, tu.created_by_member_id as reporter,
           t.id as task_id, t.project_id, t.title, t.assignee_member_id,
           t.deleted_at as task_deleted_at,
           p.visibility, p.site_id, p.deleted_at as project_deleted_at
      from task_update tu
      join task t on t.organization_id = tu.organization_id and t.id = tu.task_id
      join project p on p.organization_id = t.organization_id and p.id = t.project_id
     where tu.organization_id = ${organizationId}
       and tu.id = ${taskUpdateId}
       and tu.deleted_at is null
  `);
  const block = source.rows[0];
  // Lo que ya no existe, o no es un reporte de bloqueo (una fila falsificada), o cuelga de una
  // tarea o un proyecto borrados: no hay a quién avisar, y reintentar no lo va a arreglar.
  if (
    block?.kind !== 'block_report' ||
    block.task_deleted_at !== null ||
    block.project_deleted_at !== null
  ) {
    return 0;
  }

  const audience = await tx.execute<{ id: string }>(sql`
    with candidates(member_id) as (
      select pm.member_id
        from project_member pm
       where pm.organization_id = ${organizationId}
         and pm.project_id = ${block.project_id}
         and pm.deleted_at is null
      union
      select a.member_id
        from member_site_access a
        join auth.member sm
          on sm.id = a.member_id and sm.organization_id = a.organization_id and sm.role = 'manager'
       where ${block.visibility}::text = 'site'
         and a.organization_id = ${organizationId}
         and a.site_id = ${block.site_id}
      union
      select ${block.assignee_member_id}::text
       where ${block.assignee_member_id}::text is not null
    )
    select m.id
      from candidates c
      join auth.member m on m.id = c.member_id and m.organization_id = ${organizationId}
     where m.id <> ${block.reporter}
     order by m.id
  `);

  const payload: NotificationPayload = {
    task_title: block.title,
    actor_member_id: block.reporter,
    ...(block.body ? { reason_preview: buildReasonPreview(block.body) } : {}),
  };

  let created = 0;
  for (const { id: recipientMemberId } of audience.rows) {
    // Sin RETURNING (la policy por destinatario rechazaría leer el aviso de otro) y con
    // `ON CONFLICT DO NOTHING`: si la API ya le avisó al responsable, no se repite. El
    // contador sale de las filas afectadas.
    const inserted = await tx.execute(sql`
      insert into notification (
        id, organization_id, created_by_member_id, recipient_member_id, task_id, project_id,
        template_key, channel, payload, status, dedupe_key, sent_at
      ) values (
        ${newId()}, ${organizationId}, ${block.reporter}, ${recipientMemberId},
        ${block.task_id}, ${block.project_id}, 'task.blocked', 'inapp',
        ${JSON.stringify(payload)}::jsonb, 'delivered',
        ${blockedDedupeKey({ taskUpdateId, recipientMemberId })}, now()
      )
      on conflict do nothing
    `);
    created += inserted.rowCount ?? 0;
  }
  return created;
}

/**
 * Deja constancia de una falla, en una transacción aparte porque la del intento se deshizo. Si
 * hasta esto falla (la base caída), solo se registra en el log: la fila sigue pendiente y se
 * reintenta en la vuelta siguiente.
 */
async function recordFailure(
  db: Db,
  entry: OutboxEntry,
  error: unknown,
  requestId: string,
): Promise<void> {
  const message = (error instanceof Error ? error.message : String(error)).slice(
    0,
    MAX_ERROR_LENGTH,
  );
  try {
    const attempts = await withSystemTransaction(
      db,
      { organizationId: entry.organization_id, job: JOB, requestId },
      async (tx) => {
        const updated = await tx.execute<{ attempts: number }>(sql`
          update notification_outbox
             set attempts = attempts + 1, last_attempt_at = now(), last_error = ${message}
           where id = ${entry.id}
             and organization_id = ${entry.organization_id}
             and processed_at is null
          returning attempts
        `);
        return updated.rows[0]?.attempts ?? 0;
      },
    );
    console.error(
      `notifications.outbox: la fila ${entry.id} falló (intento ${attempts} de ${OUTBOX_MAX_ATTEMPTS}): ${message}`,
    );
    if (attempts >= OUTBOX_MAX_ATTEMPTS) {
      console.error(
        `notifications.outbox: la fila ${entry.id} agotó los intentos y queda pendiente; hay que mirarla a mano (scripts/verify-notification-outbox.sh).`,
      );
    }
  } catch (recordError) {
    console.error(
      `notifications.outbox: la fila ${entry.id} falló (${message}) y no se pudo registrar el intento:`,
      recordError,
    );
  }
}

/**
 * Sondeo cada pocos segundos. Una vuelta no se solapa con la siguiente en este proceso (una
 * base lenta no acumula vueltas); entre procesos distintos no hace falta nada, el
 * `SKIP LOCKED` los reparte. Devuelve la función que lo detiene.
 */
export function startNotificationOutboxLoop(
  db: Db,
  intervalMs: number = OUTBOX_POLL_INTERVAL_MS,
): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const summary = await processNotificationOutbox(db, crypto.randomUUID());
      if (summary.found > 0) {
        console.log(
          `notifications.outbox: ${summary.processed} procesada(s), ${summary.notifications} aviso(s) nuevo(s), ${summary.skipped} tomada(s) por otro worker, ${summary.failed} con error.`,
        );
      }
    } catch (error) {
      // Una vuelta entera que falla (la base caída) no tumba al proceso: se reintenta en la próxima.
      console.error('notifications.outbox: la vuelta falló:', error);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), intervalMs);
  void tick();
  return () => clearInterval(timer);
}
