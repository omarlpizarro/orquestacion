import { z } from 'zod';
import { base, withClientMutationId } from '../shared/base.contract.js';
import { idSchema } from '../shared/id.js';
import { notificationOutputSchema } from './list-notifications.contract.js';

export const markNotificationReadInputSchema = withClientMutationId(
  z.object({
    // Path param (`{id}`, ruta compacta de oRPC: CLAUDE.md §8 / ADR-005).
    id: idSchema,
  }),
);
export type MarkNotificationReadInput = z.infer<typeof markNotificationReadInputSchema>;

/**
 * Marca como leído un aviso propio. Sin `expected_version`: en los avisos "gana el último"
 * (docs/data-model.md, reglas de conflicto), y marcar de nuevo uno ya leído devuelve el mismo
 * `read_at`, no lo pisa. 404 si no existe **o no es de quien pide** (no se revela cuál de las
 * dos); `base` lo declara y `domain_code` lo distingue.
 */
export const markNotificationReadContract = base
  .route({
    method: 'POST',
    path: '/notifications/{id}/read',
    summary: 'Marca como leído un aviso propio',
    tags: ['notifications'],
  })
  .input(markNotificationReadInputSchema)
  .output(notificationOutputSchema);
