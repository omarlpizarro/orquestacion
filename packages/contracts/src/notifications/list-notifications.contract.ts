import { z } from 'zod';
import { base } from '../shared/base.contract.js';
import { idSchema } from '../shared/id.js';
import {
  notificationPayloadSchema,
  notificationTemplateKeySchema,
} from './notification-templates.js';

export const MAX_NOTIFICATIONS_PAGE_SIZE = 100;
export const DEFAULT_NOTIFICATIONS_PAGE_SIZE = 50;

export const listNotificationsInputSchema = z.object({
  // En la query string todo llega como texto: `'true'` y `'false'` son los únicos valores.
  unread_only: z
    .enum(['true', 'false'])
    .transform((value) => value === 'true')
    .optional(),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_NOTIFICATIONS_PAGE_SIZE)
    .default(DEFAULT_NOTIFICATIONS_PAGE_SIZE),
  // El `next_cursor` de la página anterior. Opaco para el cliente.
  cursor: z.string().min(1).max(200).optional(),
});
export type ListNotificationsInput = z.infer<typeof listNotificationsInputSchema>;

export const notificationOutputSchema = z.object({
  id: idSchema,
  template_key: notificationTemplateKeySchema,
  // Nulos solo para un aviso de la organización que no cuelga de una tarea; hoy no hay.
  task_id: idSchema.nullable(),
  project_id: idSchema.nullable(),
  payload: notificationPayloadSchema,
  created_at: z.iso.datetime(),
  // `null` si no la leyó.
  read_at: z.iso.datetime().nullable(),
});
export type NotificationOutput = z.infer<typeof notificationOutputSchema>;

export const listNotificationsOutputSchema = z.object({
  notifications: z.array(notificationOutputSchema),
  // `null` en la última página.
  next_cursor: z.string().nullable(),
  // Todos los no leídos de quien consulta, no solo los de esta página: es el número del badge.
  unread_count: z.int().min(0),
});
export type ListNotificationsOutput = z.infer<typeof listNotificationsOutputSchema>;

/**
 * Lectura, no lleva `client_mutation_id`. Devuelve solo los avisos de quien consulta, del más
 * nuevo al más viejo: nadie lee los de otra persona, ni siquiera `owner` o `director`. Quien
 * pierde el acceso a un proyecto deja de ver los avisos de ese proyecto, y quien solo tenía una
 * tarea asignada deja de ver los avisos de ella si la borran (ADR-019). 400 si el `cursor` no es
 * uno que haya devuelto esta misma consulta.
 */
export const listNotificationsContract = base
  .route({
    method: 'GET',
    path: '/notifications',
    summary: 'Lista los avisos del miembro autenticado',
    tags: ['notifications'],
  })
  .input(listNotificationsInputSchema)
  .output(listNotificationsOutputSchema);
