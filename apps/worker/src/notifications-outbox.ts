import { CollaborationService } from '@orq/api/collaboration';
import {
  NotificationsService,
  OUTBOX_MAX_ATTEMPTS,
  TASK_BLOCKED_OUTBOX_KIND,
} from '@orq/api/notifications';
import { ProjectAudienceService } from '@orq/api/projects';
import { TenancyService } from '@orq/api/tenancy';
import type { Db } from '@orq/db';
import { withSystemScanTransaction, withSystemTransaction } from '@orq/db/system';

/**
 * Procesa la bandeja de pendientes de `notification_outbox` (ADR-019): el worker completa los
 * avisos cuya audiencia la API no pudo calcular, porque quien actúa puede ser un operario "solo
 * asignado" que no ve `project_member`. El patrón es el mismo que va a usar el push de la parte 2:
 * una fila en la misma transacción que el cambio, y un proceso aparte que la levanta.
 *
 * Este archivo no tiene SQL. Orquesta servicios que los módulos exportan, con la transacción de
 * sistema del worker: `NotificationsService` (la bandeja y los avisos) y `ProjectAudienceService`
 * (a quién avisar de un bloqueo: la misma definición que usa la API). El worker solo importa lo
 * que los módulos exportan (`@orq/api/<módulo>`, que apunta al archivo de módulo); cualquier otra
 * ruta la rechazan `exports` y `dependency-cruiser`.
 */
export const OUTBOX_POLL_INTERVAL_MS = 5_000;
export { OUTBOX_MAX_ATTEMPTS };

const MAX_ERROR_LENGTH = 1_000;
const JOB = 'notifications.outbox';

/** Los servicios no tienen estado: se arman a mano, el worker no levanta el contenedor de Nest. */
export interface OutboxServices {
  notifications: NotificationsService;
  audience: ProjectAudienceService;
}

export function createOutboxServices(): OutboxServices {
  return {
    notifications: new NotificationsService(),
    audience: new ProjectAudienceService(new CollaborationService(), new TenancyService()),
  };
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

interface Entry {
  id: string;
  organizationId: string;
}

/**
 * Una vuelta: busca los pendientes de todas las organizaciones y procesa cada uno en su propia
 * transacción. Una fila que falla no frena a las demás.
 */
export async function processNotificationOutbox(
  db: Db,
  requestId: string,
  services: OutboxServices = createOutboxServices(),
): Promise<OutboxRunSummary> {
  const summary: OutboxRunSummary = {
    found: 0,
    processed: 0,
    notifications: 0,
    skipped: 0,
    failed: 0,
  };

  // Lectura transversal, solo para localizar. No toma locks: el bloqueo es por fila, abajo.
  const entries = await withSystemScanTransaction(db, { job: JOB, requestId }, (tx) =>
    services.notifications.listPendingOutbox(tx),
  );
  summary.found = entries.length;

  for (const entry of entries) {
    try {
      const outcome = await processEntry(db, entry, requestId, services);
      if (outcome === 'skipped') {
        summary.skipped += 1;
      } else {
        summary.processed += 1;
        summary.notifications += outcome.notifications;
      }
    } catch (error) {
      summary.failed += 1;
      await recordFailure(db, entry, error, requestId, services);
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
  entry: Entry,
  requestId: string,
  services: OutboxServices,
): Promise<'skipped' | { notifications: number }> {
  const { organizationId } = entry;
  return withSystemTransaction(db, { organizationId, job: JOB, requestId }, async (tx) => {
    const claimed = await services.notifications.claimOutboxEntry(tx, {
      organizationId,
      id: entry.id,
    });
    if (!claimed) return 'skipped';

    // No se confía en nada de la fila más allá de los ids: el tipo despacha y el resto se
    // recalcula desde la base.
    if (claimed.kind !== TASK_BLOCKED_OUTBOX_KIND) {
      throw new Error(`Tipo de pendiente desconocido: ${claimed.kind}`);
    }
    // Sin audiencia (la novedad no existe, no es un bloqueo, o su tarea o su proyecto están
    // borrados): no hay a quién avisar y reintentar no lo va a arreglar. La fila se da por lista.
    const audience = await services.audience.listTaskBlockAudience(tx, {
      organizationId,
      taskUpdateId: claimed.entityId,
    });
    const notifications = audience
      ? await services.notifications.notifyTaskBlocked(tx, {
          organizationId,
          actorMemberId: audience.reporterMemberId,
          recipientMemberIds: audience.recipientMemberIds,
          taskId: audience.taskId,
          projectId: audience.projectId,
          taskTitle: audience.taskTitle,
          taskUpdateId: audience.taskUpdateId,
          reason: audience.reason,
        })
      : 0;

    await services.notifications.markOutboxEntryProcessed(tx, { organizationId, id: entry.id });
    return { notifications };
  });
}

/**
 * Deja constancia de una falla, en una transacción aparte porque la del intento se deshizo. Si
 * hasta esto falla (la base caída), solo se registra en el log: la fila sigue pendiente y se
 * reintenta en la vuelta siguiente.
 */
async function recordFailure(
  db: Db,
  entry: Entry,
  error: unknown,
  requestId: string,
  services: OutboxServices,
): Promise<void> {
  const message = (error instanceof Error ? error.message : String(error)).slice(
    0,
    MAX_ERROR_LENGTH,
  );
  try {
    const attempts = await withSystemTransaction(
      db,
      { organizationId: entry.organizationId, job: JOB, requestId },
      (tx) =>
        services.notifications.recordOutboxFailure(tx, {
          organizationId: entry.organizationId,
          id: entry.id,
          message,
        }),
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
  const services = createOutboxServices();
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const summary = await processNotificationOutbox(db, crypto.randomUUID(), services);
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
