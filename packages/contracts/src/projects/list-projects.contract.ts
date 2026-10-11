import { z } from 'zod';
import { base } from '../shared/base.contract.js';
import { projectOutputSchema } from './create-project.contract.js';

export const listProjectsInputSchema = z.object({
  // Viene por query string, así que llega como texto.
  limit: z.coerce.number().int().min(1).max(200).optional(),
});
export type ListProjectsInput = z.infer<typeof listProjectsInputSchema>;

export const listProjectsOutputSchema = z.object({
  projects: z.array(projectOutputSchema),
});
export type ListProjectsOutput = z.infer<typeof listProjectsOutputSchema>;

/** Lectura: no lleva `client_mutation_id`. Lista solo lo que RLS deja ver. */
export const listProjectsContract = base
  .route({
    method: 'GET',
    path: '/projects',
    summary: 'Lista los proyectos visibles para quien consulta, los más nuevos primero',
    tags: ['projects'],
  })
  .input(listProjectsInputSchema)
  .output(listProjectsOutputSchema);
