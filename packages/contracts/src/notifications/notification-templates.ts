import { z } from 'zod';

/**
 * Los avisos dentro de la app (ADR-019). Las plantillas, la forma del `payload` y las claves
 * de deduplicación viven acá, y no en la API ni en el worker, porque un aviso lo arman los
 * dos: la API crea los que no necesitan calcular una audiencia (el responsable de la tarea)
 * y el worker los de la audiencia. Si cada uno armara su propio `payload` o su propia
 * `dedupe_key`, un mismo aviso saldría dos veces o con dos formas distintas.
 */
export const notificationTemplateKeySchema = z.enum(['task.assigned', 'task.blocked']);
export type NotificationTemplateKey = z.infer<typeof notificationTemplateKeySchema>;

/** Largo máximo del extracto del motivo de un bloqueo que viaja en el aviso. */
export const REASON_PREVIEW_MAX_LENGTH = 140;

/**
 * Lo que lleva un aviso. Son fotos del momento (el título de la tarea puede cambiar
 * después), a propósito: el aviso dice qué pasó cuando pasó. Sin nombres de personas, solo
 * ids: los nombres los resuelve el cliente en lote.
 */
export const notificationPayloadSchema = z.object({
  task_title: z.string(),
  // Quién hizo la acción que genera el aviso (quien asignó, quien bloqueó).
  actor_member_id: z.string(),
  // Solo en `task.blocked`: el comienzo del motivo.
  reason_preview: z.string().optional(),
});
export type NotificationPayload = z.infer<typeof notificationPayloadSchema>;

/** Espacios colapsados y recortado a `REASON_PREVIEW_MAX_LENGTH`, con puntos suspensivos si cortó. */
export function buildReasonPreview(reason: string): string {
  const flat = reason.replace(/\s+/g, ' ').trim();
  if (flat.length <= REASON_PREVIEW_MAX_LENGTH) return flat;
  return `${flat.slice(0, REASON_PREVIEW_MAX_LENGTH - 1).trimEnd()}…`;
}

/**
 * `<tarea>:assigned:<destinatario>:<versión de la tarea tras asignar>`: la misma asignación
 * (un reintento) no avisa dos veces; una reasignación posterior sí, porque la versión cambió.
 */
export function assignedDedupeKey(params: {
  taskId: string;
  recipientMemberId: string;
  taskVersion: number;
}): string {
  return `task:${params.taskId}:assigned:${params.recipientMemberId}:${params.taskVersion}`;
}

/**
 * `<novedad>:blocked:<destinatario>`: el aviso de un bloqueo lo pueden armar dos caminos (la
 * API para el responsable, el worker para la audiencia) y esta clave hace que, si el
 * responsable también está en la audiencia, reciba uno solo.
 */
export function blockedDedupeKey(params: {
  taskUpdateId: string;
  recipientMemberId: string;
}): string {
  return `task_update:${params.taskUpdateId}:blocked:${params.recipientMemberId}`;
}
