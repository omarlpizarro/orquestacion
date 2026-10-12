import { z } from 'zod';
import { base, withClientMutationId } from '../shared/base.contract.js';
import { idSchema } from '../shared/id.js';
import { memberIdSchema } from '../shared/member-id.js';

export const addProjectMemberInputSchema = withClientMutationId(
  z.object({
    project_id: idSchema,
    member_id: memberIdSchema,
  }),
);
export type AddProjectMemberInput = z.infer<typeof addProjectMemberInputSchema>;

export const addProjectMemberOutputSchema = z.object({
  project_id: idSchema,
  member_id: memberIdSchema,
});
export type AddProjectMemberOutput = z.infer<typeof addProjectMemberOutputSchema>;

/**
 * Idempotente por diseño, además del `client_mutation_id`: agregar a quien ya es
 * miembro no es un error. Se puede agregar a cualquier miembro de la
 * organización, sin requisito de acceso al sitio (ADR-017 §8).
 */
export const addProjectMemberContract = base
  .route({
    method: 'POST',
    path: '/projects/{project_id}/members',
    summary: 'Agrega un miembro explícito a un proyecto',
    tags: ['projects'],
  })
  .input(addProjectMemberInputSchema)
  .output(addProjectMemberOutputSchema);
