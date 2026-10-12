import { z } from 'zod';
import { base, withClientMutationId } from '../shared/base.contract.js';
import { idSchema } from '../shared/id.js';
import { taskUpdateOutputSchema } from './task-tree.contract.js';

export const addTaskCommentInputSchema = withClientMutationId(
  z.object({
    // Path param (`{task_id}`, ruta compacta de oRPC: CLAUDE.md §8 / ADR-005).
    task_id: idSchema,
    // UUIDv7 generado en el cliente (CLAUDE.md regla dura 6): es el id de la novedad.
    // Distinto de `client_mutation_id`, que identifica el intento.
    id: idSchema,
    // Solo texto. Se recorta; tiene que quedar al menos un carácter visible (la base
    // lo exige también: `task_update_body_required_check`).
    body: z.string().trim().min(1).max(4000),
  }),
);
export type AddTaskCommentInput = z.infer<typeof addTaskCommentInputSchema>;

/**
 * Sin `.errors()` propio: 404 si la tarea no existe **o si quien comenta no la ve**
 * (ADR-017 §6), 409 si el `id` de la novedad ya existe o si el `client_mutation_id`
 * ya se usó para otra operación; `base` los declara y `domain_code` los distingue.
 *
 * Comentan quienes ven la tarea: acceso completo al proyecto, o "solo asignado" en
 * sus propias tareas (ADR-017 §1). Devuelve la novedad creada.
 */
export const addTaskCommentContract = base
  .route({
    method: 'POST',
    path: '/projects/tasks/{task_id}/comments',
    summary: 'Agrega un comentario de texto a una tarea',
    tags: ['projects'],
  })
  .input(addTaskCommentInputSchema)
  .output(taskUpdateOutputSchema);
