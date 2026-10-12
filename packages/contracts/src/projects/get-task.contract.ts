import { z } from 'zod';
import { base } from '../shared/base.contract.js';
import { idSchema } from '../shared/id.js';
import { taskTreeNodeSchema, taskUpdateOutputSchema } from './task-tree.contract.js';

export const getTaskInputSchema = z.object({
  // Path param (`{id}`, ruta compacta de oRPC: CLAUDE.md §8 / ADR-005), igual que
  // `change-task-status`.
  id: idSchema,
});
export type GetTaskInput = z.infer<typeof getTaskInputSchema>;

export const getTaskOutputSchema = taskTreeNodeSchema.extend({
  // Las novedades de ESTA tarea (no las de sus subtareas), de la más vieja a la
  // más nueva. Si hay más que el tope, quedan las más recientes.
  updates: z.array(taskUpdateOutputSchema),
  updates_truncated: z.boolean(),
  // Si la tarea tiene más subtareas que el tope, el árbol viene recortado.
  subtasks_truncated: z.boolean(),
});
export type GetTaskOutput = z.infer<typeof getTaskOutputSchema>;

/**
 * Lectura: no lleva `client_mutation_id`. Sin `.errors()` propio: 404 si la tarea
 * no existe **o si quien pregunta no la ve** (ADR-017 §6; el nivel "solo asignado"
 * ve únicamente sus propias tareas), `base` ya lo declara.
 */
export const getTaskContract = base
  .route({
    method: 'GET',
    path: '/projects/tasks/{id}',
    summary: 'Devuelve una tarea con su árbol de subtareas visibles y sus novedades',
    tags: ['projects'],
  })
  .input(getTaskInputSchema)
  .output(getTaskOutputSchema);
