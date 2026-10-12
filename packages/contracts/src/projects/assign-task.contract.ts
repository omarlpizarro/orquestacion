import { z } from 'zod';
import { base, withClientMutationId } from '../shared/base.contract.js';
import { idSchema } from '../shared/id.js';
import { memberIdSchema } from '../shared/member-id.js';
import { taskOutputSchema } from './create-task.contract.js';

export const assignTaskInputSchema = withClientMutationId(
  // Estricto: cualquier otro campo se rechaza con 400 nombrándolo (CLAUDE.md §9).
  z.strictObject({
    // Path param (`{id}`, ruta compacta de oRPC: CLAUDE.md §8 / ADR-005), igual que
    // `change-task-status`.
    id: idSchema,
    // Concurrencia optimista: obligatoria. En las asignaciones gana el servidor
    // (CLAUDE.md §9): una versión vieja se rechaza con 409, nunca se mezcla.
    expected_version: z.int().min(1),
    // Obligatorio y explícito: el miembro al que se le asigna, o `null` para dejar la
    // tarea sin responsable. Omitirlo es un error, no "no cambiar".
    assignee_member_id: memberIdSchema.nullable(),
  }),
);
export type AssignTaskInput = z.infer<typeof assignTaskInputSchema>;

/**
 * Asigna, reasigna o desasigna una tarea. Devuelve la tarea. Sin `.errors()` propio:
 * 404 si no existe o quien pide no la ve, 403 si la ve y no puede asignar (rol sin
 * `task:assign`, o acceso solo por una tarea asignada), 422 si está cancelada o si el
 * responsable no es asignable (no es de la organización o no trabaja en el sitio del
 * proyecto), 409 por versión; `base` los declara y `domain_code` los distingue
 * (CLAUDE.md §8). Pedir el responsable que ya tiene no cambia nada.
 */
export const assignTaskContract = base
  .route({
    method: 'PATCH',
    path: '/projects/tasks/{id}/assignee',
    summary: 'Asigna, reasigna o desasigna el responsable de una tarea',
    tags: ['projects'],
  })
  .input(assignTaskInputSchema)
  .output(taskOutputSchema);
