import { Injectable } from '@nestjs/common';
import {
  assignedDedupeKey,
  blockedDedupeKey,
  buildReasonPreview,
  type NotificationPayload,
  newId,
} from '@orq/contracts';
import type { Tx } from '@orq/db';
import {
  claimOutboxEntry,
  findPendingOutboxEntries,
  insertNotification,
  insertOutboxEntry,
  markOutboxEntryProcessed,
  type OutboxEntryRef,
  recordOutboxFailure,
} from './infrastructure/notification.repository.js';

/** `notification_outbox.kind` del bloqueo de una tarea; lo despacha el worker (ADR-019). */
export const TASK_BLOCKED_OUTBOX_KIND = 'task.blocked';

/** Pasado este número de intentos fallidos la fila deja de reintentarse; sigue pendiente y a la vista. */
export const OUTBOX_MAX_ATTEMPTS = 10;
/** Espera entre reintentos: `min(intentos, 6) × 30 s`, así una falla persistente no se reintenta a ritmo de sondeo. */
export const OUTBOX_BACKOFF_STEP_SECONDS = 30;
export const OUTBOX_BATCH_SIZE = 50;

/**
 * Único punto por el que otro módulo (o el worker) crea avisos y toca la bandeja (CLAUDE.md §5):
 * `projects` decide a quién avisar y qué pasó, y no puede escribir en una tabla que no es suya.
 * Todo corre con el `tx` de quien llama (ADR-019): en la API, dentro de la transacción de la
 * mutación, de modo que el aviso y el cambio que lo causa confirman juntos o no confirman; en el
 * worker, dentro de la transacción de sistema de la fila que procesa. Por eso nada acá abre una
 * transacción propia.
 *
 * Este servicio no calcula audiencias: recibe los destinatarios ya resueltos. La audiencia de un
 * bloqueo la define `projects` (`ProjectAudienceService`), una sola vez, para la API y el worker.
 */
@Injectable()
export class NotificationsService {
  /**
   * Avisa a `recipientMemberId` que se le asignó una tarea. No avisa a quien se asigna a sí mismo.
   * `taskVersion` es la de la tarea ya asignada: la misma asignación (un reintento) no avisa dos
   * veces, y una reasignación posterior sí.
   */
  async notifyTaskAssigned(
    tx: Tx,
    params: {
      organizationId: string;
      actorMemberId: string;
      recipientMemberId: string;
      taskId: string;
      projectId: string;
      taskTitle: string;
      taskVersion: number;
    },
  ): Promise<void> {
    if (params.recipientMemberId === params.actorMemberId) return;
    await insertNotification(tx, {
      id: newId(),
      organizationId: params.organizationId,
      createdByMemberId: params.actorMemberId,
      recipientMemberId: params.recipientMemberId,
      taskId: params.taskId,
      projectId: params.projectId,
      templateKey: 'task.assigned',
      payload: { task_title: params.taskTitle, actor_member_id: params.actorMemberId },
      dedupeKey: assignedDedupeKey({
        taskId: params.taskId,
        recipientMemberId: params.recipientMemberId,
        taskVersion: params.taskVersion,
      }),
    });
  }

  /**
   * Avisa de un bloqueo a cada destinatario, que no incluye a quien bloqueó. La `dedupe_key` es la
   * misma desde la API y desde el worker (`blockedDedupeKey`): quien reciba el aviso por los dos
   * caminos recibe uno solo. Es idempotente, así que el worker puede volver a avisar a quien la API
   * ya avisó. Devuelve cuántos avisos nuevos creó (los que ya existían no cuentan).
   */
  async notifyTaskBlocked(
    tx: Tx,
    params: {
      organizationId: string;
      actorMemberId: string;
      recipientMemberIds: readonly string[];
      taskId: string;
      projectId: string;
      taskTitle: string;
      taskUpdateId: string;
      reason: string | null;
    },
  ): Promise<number> {
    const payload: NotificationPayload = {
      task_title: params.taskTitle,
      actor_member_id: params.actorMemberId,
      ...(params.reason ? { reason_preview: buildReasonPreview(params.reason) } : {}),
    };
    let created = 0;
    for (const recipientMemberId of params.recipientMemberIds) {
      if (recipientMemberId === params.actorMemberId) continue;
      const inserted = await insertNotification(tx, {
        id: newId(),
        organizationId: params.organizationId,
        createdByMemberId: params.actorMemberId,
        recipientMemberId,
        taskId: params.taskId,
        projectId: params.projectId,
        templateKey: 'task.blocked',
        payload,
        dedupeKey: blockedDedupeKey({ taskUpdateId: params.taskUpdateId, recipientMemberId }),
      });
      if (inserted) created += 1;
    }
    return created;
  }

  /**
   * Deja en la bandeja el pedido de completar los avisos de un bloqueo. Lleva solo el id de la
   * novedad: el worker recalcula todo desde la base.
   */
  async enqueueTaskBlockedFanout(
    tx: Tx,
    params: { organizationId: string; actorMemberId: string; taskUpdateId: string },
  ): Promise<void> {
    await insertOutboxEntry(tx, {
      id: newId(),
      organizationId: params.organizationId,
      createdByMemberId: params.actorMemberId,
      kind: TASK_BLOCKED_OUTBOX_KIND,
      entityId: params.taskUpdateId,
    });
  }

  // --- Lado del worker: consumir la bandeja ---

  /**
   * Los pendientes de todas las organizaciones, para procesarlos de a uno. Hay que llamarlo con la
   * transacción de lectura transversal de sistema (`withSystemScanTransaction`); con otra, vacío.
   */
  listPendingOutbox(tx: Tx, params: { limit?: number } = {}): Promise<OutboxEntryRef[]> {
    return findPendingOutboxEntries(tx, {
      limit: params.limit ?? OUTBOX_BATCH_SIZE,
      maxAttempts: OUTBOX_MAX_ATTEMPTS,
      backoffStepSeconds: OUTBOX_BACKOFF_STEP_SECONDS,
    });
  }

  /** Toma una fila para procesarla (`FOR UPDATE SKIP LOCKED`); `null` si otro la tiene o ya está lista. */
  claimOutboxEntry(
    tx: Tx,
    params: { organizationId: string; id: string },
  ): Promise<{ kind: string; entityId: string } | null> {
    return claimOutboxEntry(tx, params);
  }

  markOutboxEntryProcessed(tx: Tx, params: { organizationId: string; id: string }): Promise<void> {
    return markOutboxEntryProcessed(tx, params);
  }

  /** Suma un intento fallido y guarda el error; devuelve cuántos lleva la fila. */
  recordOutboxFailure(
    tx: Tx,
    params: { organizationId: string; id: string; message: string },
  ): Promise<number> {
    return recordOutboxFailure(tx, params);
  }
}
