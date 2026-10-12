import { z } from 'zod';
import { base, withClientMutationId } from '../shared/base.contract.js';
import { idSchema } from '../shared/id.js';
import { projectOutputSchema, projectVisibilitySchema } from './create-project.contract.js';

export const changeProjectVisibilityInputSchema = withClientMutationId(
  z.object({
    project_id: idSchema,
    visibility: projectVisibilitySchema,
    // Concurrencia optimista, igual que `change-task-status`.
    expected_version: z.int().min(1),
  }),
);
export type ChangeProjectVisibilityInput = z.infer<typeof changeProjectVisibilityInputSchema>;

/** Cambian la visibilidad el creador, `owner` y `director` (ADR-017 §8). */
export const changeProjectVisibilityContract = base
  .route({
    method: 'PATCH',
    path: '/projects/{project_id}/visibility',
    summary: 'Cambia la visibilidad de un proyecto (reservado o abierto al sitio)',
    tags: ['projects'],
  })
  .input(changeProjectVisibilityInputSchema)
  .output(projectOutputSchema);
