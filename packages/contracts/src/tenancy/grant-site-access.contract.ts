import { z } from 'zod';
import { base, withClientMutationId } from '../shared/base.contract.js';
import { idSchema } from '../shared/id.js';
import { memberIdSchema } from '../shared/member-id.js';

export const grantSiteAccessInputSchema = withClientMutationId(
  z.object({
    // Path param (`{site_id}`, ruta compacta de oRPC: CLAUDE.md §8 / ADR-005).
    site_id: idSchema,
    member_id: memberIdSchema,
  }),
);
export type GrantSiteAccessInput = z.infer<typeof grantSiteAccessInputSchema>;

export const grantSiteAccessOutputSchema = z.object({
  site_id: idSchema,
  member_id: memberIdSchema,
});
export type GrantSiteAccessOutput = z.infer<typeof grantSiteAccessOutputSchema>;

/**
 * Sin `.errors()` propio: los casos de este slice (rol sin permiso, sitio
 * inexistente, miembro que no es de la organización, miembro con acceso
 * implícito a todos los sitios) son FORBIDDEN/NOT_FOUND/UNPROCESSABLE_CONTENT,
 * ya declarados en `base`; `domain_code` los distingue entre sí
 * (CLAUDE.md §8).
 *
 * Idempotente por diseño, además del `client_mutation_id`: otorgar un acceso
 * que el miembro ya tiene no es un error, devuelve lo mismo.
 */
export const grantSiteAccessContract = base
  .route({
    method: 'POST',
    path: '/tenancy/sites/{site_id}/access',
    summary: 'Otorga a un miembro acceso a un sitio',
    tags: ['tenancy'],
  })
  .input(grantSiteAccessInputSchema)
  .output(grantSiteAccessOutputSchema);
