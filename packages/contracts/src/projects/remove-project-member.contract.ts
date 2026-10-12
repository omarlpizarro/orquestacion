import { z } from 'zod';
import { base, withClientMutationId } from '../shared/base.contract.js';
import { idSchema } from '../shared/id.js';
import { memberIdSchema } from '../shared/member-id.js';

export const removeProjectMemberInputSchema = withClientMutationId(
  z.object({
    project_id: idSchema,
    member_id: memberIdSchema,
  }),
);
export type RemoveProjectMemberInput = z.infer<typeof removeProjectMemberInputSchema>;

export const removeProjectMemberOutputSchema = z.object({
  project_id: idSchema,
  member_id: memberIdSchema,
  // Quitar a alguien no toca sus tareas (ADR-017 §8): conserva el nivel "solo
  // asignado" mientras le queden. Se informa para que alguien decida reasignar.
  remaining_assigned_task_count: z.int().min(0),
});
export type RemoveProjectMemberOutput = z.infer<typeof removeProjectMemberOutputSchema>;

/**
 * Quitan los mismos que agregan, y cualquier miembro, el creador incluido,
 * puede salirse a sí mismo. Cuando lo quita otra persona, al creador lo quitan
 * solo `owner` o `director`.
 */
export const removeProjectMemberContract = base
  .route({
    method: 'DELETE',
    path: '/projects/{project_id}/members/{member_id}',
    summary: 'Quita un miembro explícito de un proyecto',
    tags: ['projects'],
  })
  .input(removeProjectMemberInputSchema)
  .output(removeProjectMemberOutputSchema);
