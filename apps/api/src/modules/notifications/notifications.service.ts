import { Injectable } from '@nestjs/common';
import {
  assignedDedupeKey,
  blockedDedupeKey,
  buildReasonPreview,
  type NotificationPayload,
  newId,
} from '@orq/contracts';
import type { Tx } from '@orq/db';
import { insertNotification, insertOutboxEntry } from './infrastructure/notification.repository.js';

/** `notification_outbox.kind` del bloqueo de una tarea; lo despacha el worker (ADR-019). */
export const TASK_BLOCKED_OUTBOX_KIND = 'task.blocked';

/**
 * Único punto por el que otro módulo crea avisos (CLAUDE.md §5): `projects` decide a quién avisar
 * y qué pasó, y no puede escribir en una tabla que no es suya. Todo corre con el `tx` de quien
 * llama, dentro de la transacción de la mutación (ADR-019): el aviso y el cambio que lo causa
 * confirman juntos o no confirman. Por eso nada acá abre una transacción propia.
 *
 * Este servicio no calcula audiencias. Los avisos que crea son para una persona que quien llama
 * ya tiene a mano (el responsable de la tarea). Cuando la audiencia exige ver lo que quien actúa
 * no puede (quién es miembro de un proyecto reservado), se encola en la bandeja y la arma el
 * worker (`enqueueTaskBlockedFanout`).
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
   * Avisa al responsable de la tarea que alguien la bloqueó. No avisa a quien bloqueó (ve su
   * propia tarea). Comparte `dedupe_key` con el aviso que arma el worker, así que si el
   * responsable también pertenece a la audiencia recibe uno solo.
   */
  async notifyTaskBlockedToAssignee(
    tx: Tx,
    params: {
      organizationId: string;
      actorMemberId: string;
      assigneeMemberId: string;
      taskId: string;
      projectId: string;
      taskTitle: string;
      taskUpdateId: string;
      reason: string;
    },
  ): Promise<void> {
    if (params.assigneeMemberId === params.actorMemberId) return;
    const payload: NotificationPayload = {
      task_title: params.taskTitle,
      actor_member_id: params.actorMemberId,
      reason_preview: buildReasonPreview(params.reason),
    };
    await insertNotification(tx, {
      id: newId(),
      organizationId: params.organizationId,
      createdByMemberId: params.actorMemberId,
      recipientMemberId: params.assigneeMemberId,
      taskId: params.taskId,
      projectId: params.projectId,
      templateKey: 'task.blocked',
      payload,
      dedupeKey: blockedDedupeKey({
        taskUpdateId: params.taskUpdateId,
        recipientMemberId: params.assigneeMemberId,
      }),
    });
  }

  /**
   * Deja en la bandeja el pedido de avisar un bloqueo a su audiencia (miembros del proyecto y
   * managers del sitio). Lleva solo el id de la novedad: el worker recalcula todo desde la base.
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
}
