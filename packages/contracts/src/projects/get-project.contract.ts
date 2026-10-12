import { z } from 'zod';
import { base } from '../shared/base.contract.js';
import { idSchema } from '../shared/id.js';
import { projectOutputSchema } from './create-project.contract.js';

export const getProjectInputSchema = z.object({
  // Path param (`{project_id}`, ruta compacta de oRPC: CLAUDE.md §8 / ADR-005).
  project_id: idSchema,
});
export type GetProjectInput = z.infer<typeof getProjectInputSchema>;

/** 404 si no existe o si la persona no lo ve (ADR-017 §6): no se distinguen. */
export const getProjectContract = base
  .route({
    method: 'GET',
    path: '/projects/{project_id}',
    summary: 'Devuelve un proyecto visible para quien consulta',
    tags: ['projects'],
  })
  .input(getProjectInputSchema)
  .output(projectOutputSchema);
