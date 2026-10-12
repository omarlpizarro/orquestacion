import { z } from 'zod';
import { base } from '../shared/base.contract.js';
import { idSchema } from '../shared/id.js';
import { projectAccessLevelSchema } from './create-project.contract.js';
import { taskTreeNodeSchema } from './task-tree.contract.js';

export const listProjectTasksInputSchema = z.object({
  // Path param (`{project_id}`, ruta compacta de oRPC: CLAUDE.md §8 / ADR-005).
  project_id: idSchema,
});
export type ListProjectTasksInput = z.infer<typeof listProjectTasksInputSchema>;

export const listProjectTasksOutputSchema = z.object({
  // Con `assigned`, la lista es solo lo que esa persona tiene asignado (ADR-017 §1).
  access_level: projectAccessLevelSchema,
  // Las tareas raíz, cada una con su árbol de subtareas; hermanas por `position`.
  tasks: z.array(taskTreeNodeSchema),
  // Si el proyecto tiene más tareas que el tope, vienen las de menor profundidad.
  truncated: z.boolean(),
});
export type ListProjectTasksOutput = z.infer<typeof listProjectTasksOutputSchema>;

/**
 * Lectura: no lleva `client_mutation_id`. 404 si el proyecto no existe o si quien
 * pregunta no lo ve (ADR-017 §6).
 */
export const listProjectTasksContract = base
  .route({
    method: 'GET',
    path: '/projects/{project_id}/tasks',
    summary: 'Lista las tareas de un proyecto, como árbol, las que quien consulta puede ver',
    tags: ['projects'],
  })
  .input(listProjectTasksInputSchema)
  .output(listProjectTasksOutputSchema);
