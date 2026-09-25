import { z } from 'zod';
import { base, withClientMutationId } from '../shared/base.contract.js';
import { idSchema } from '../shared/id.js';
import { taskOutputSchema, taskStatusSchema } from './create-task.contract.js';

export const changeTaskStatusInputSchema = withClientMutationId(
  z.object({
    // Path param (`{id}`, ruta compacta de oRPC: CLAUDE.md §8 / ADR-005).
    id: idSchema,
    to_status: taskStatusSchema,
    // Concurrencia optimista (docs/data-model.md, convención
    // "Concurrencia"): la versión que el cliente vio la última vez. El
    // servidor nunca la infiere ni la ignora — si no coincide con la que
    // hay en base, la mutación se rechaza en vez de pisar un cambio ajeno.
    expected_version: z.int().min(1),
    // Exigido solo cuando la transición lo pide (bloquear o reabrir,
    // `resolveTaskStatusTransition`); no hay forma de saberlo en el
    // contrato sin duplicar la tabla de transiciones acá, así que queda
    // opcional y el dominio decide si hacía falta.
    reason: z.string().min(1).max(2000).optional(),
  }),
);
export type ChangeTaskStatusInput = z.infer<typeof changeTaskStatusInputSchema>;

/**
 * Sin `.errors()` propio: los casos de este slice (tarea inexistente,
 * transición inválida, rol sin permiso, motivo faltante, versión
 * desactualizada) son NOT_FOUND/UNPROCESSABLE_CONTENT/FORBIDDEN/CONFLICT,
 * los cuatro ya declarados en `base`. `domain_code` (`domainErrorData`) es
 * lo que los distingue entre sí (CLAUDE.md §8).
 */
export const changeTaskStatusContract = base
  .route({
    method: 'PATCH',
    path: '/projects/tasks/{id}/status',
    summary: 'Cambia el estado de una tarea',
    tags: ['projects'],
  })
  .input(changeTaskStatusInputSchema)
  .output(taskOutputSchema);
