import { z } from 'zod';
import { idSchema } from '../shared/id.js';
import { memberIdSchema } from '../shared/member-id.js';
import { taskOutputSchema } from './create-task.contract.js';

/**
 * Árbol de subtareas. El dominio limita la profundidad a tres niveles (ADR-006,
 * `MAX_TASK_DEPTH` en `apps/api/src/modules/projects/domain/max-task-depth.ts`),
 * así que el árbol se declara con tres niveles explícitos en vez de un esquema
 * recursivo (`z.lazy`), que no baja bien a OpenAPI. Si esa constante cambia, hay
 * que cambiar esto: un test de la API lo vigila.
 *
 * Una subtarea que quien lee ve pero cuyo padre no ve (el nivel "solo asignado" de
 * ADR-017 §1 ve únicamente sus propias tareas) cuelga de la raíz que se pidió,
 * con su `parent_task_id` y su `depth` reales: el cliente puede distinguirla.
 */
const leafNodeSchema = taskOutputSchema.extend({
  subtasks: z.tuple([]),
});
const middleNodeSchema = taskOutputSchema.extend({
  subtasks: z.array(leafNodeSchema),
});
export const taskTreeNodeSchema = taskOutputSchema.extend({
  subtasks: z.array(middleNodeSchema),
});
export type TaskTreeNode = z.infer<typeof taskTreeNodeSchema>;

/** `task_update_kind_check` (0006 y 0007). */
export const taskUpdateKindSchema = z.enum([
  'comment',
  'status_change',
  'block_report',
  'evidence',
  'system',
  'reopen',
]);

/** Una novedad de la tarea (RF-E2): lo que la gente escribe, no el audit trail. */
export const taskUpdateOutputSchema = z.object({
  id: idSchema,
  task_id: idSchema,
  kind: taskUpdateKindSchema,
  // `null` en los cambios de estado que no piden motivo.
  body: z.string().nullable(),
  // `{ from, to }` en un cambio de estado; vacío en el resto.
  metadata: z.record(z.string(), z.unknown()),
  created_by_member_id: memberIdSchema,
  created_at: z.iso.datetime(),
});
export type TaskUpdateOutput = z.infer<typeof taskUpdateOutputSchema>;
