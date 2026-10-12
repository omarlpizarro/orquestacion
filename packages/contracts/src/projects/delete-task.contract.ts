import { z } from 'zod';
import { base, withClientMutationId } from '../shared/base.contract.js';
import { idSchema } from '../shared/id.js';

export const deleteTaskInputSchema = withClientMutationId(
  // Estricto: cualquier otro campo se rechaza con 400 nombrándolo (CLAUDE.md §9).
  z.strictObject({
    // Path param (`{id}`, ruta compacta de oRPC: CLAUDE.md §8 / ADR-005), igual que
    // `change-task-status`.
    id: idSchema,
    // Concurrencia optimista sobre la tarea que se borra: obligatoria.
    expected_version: z.int().min(1),
  }),
);
export type DeleteTaskInput = z.infer<typeof deleteTaskInputSchema>;

export const deleteTaskOutputSchema = z.object({
  id: idSchema,
  // Cuándo se borró; es el mismo instante para la tarea y su subárbol.
  deleted_at: z.iso.datetime(),
  // Cuántas tareas se borraron: la tarea y todas sus subtareas.
  deleted_task_count: z.int().min(1),
});
export type DeleteTaskOutput = z.infer<typeof deleteTaskOutputSchema>;

/**
 * Borra una tarea **y todo su subárbol**, lógicamente (`deleted_at`, regla dura 9):
 * las filas siguen, quedan en el audit y dejan de verse. Sin `.errors()` propio: 404 si
 * no existe o quien pide no la ve, 403 si la ve y no puede borrar (rol sin
 * `task:delete`, o acceso solo por una tarea asignada), 409 por versión; `base` los
 * declara y `domain_code` los distingue (CLAUDE.md §8). Las novedades de las tareas
 * borradas se conservan.
 */
export const deleteTaskContract = base
  .route({
    method: 'DELETE',
    path: '/projects/tasks/{id}',
    summary: 'Borra una tarea y todas sus subtareas',
    tags: ['projects'],
  })
  .input(deleteTaskInputSchema)
  .output(deleteTaskOutputSchema);
