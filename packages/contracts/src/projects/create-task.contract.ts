import { z } from 'zod';
import { base, withClientMutationId } from '../shared/base.contract.js';
import { idSchema } from '../shared/id.js';
import { localDateTimeSchema } from '../shared/local-datetime.js';
import { memberIdSchema } from '../shared/member-id.js';

export const createTaskInputSchema = withClientMutationId(
  z.object({
    // UUIDv7 generado en el cliente (CLAUDE.md regla dura 6): el móvil
    // offline crea la fila antes de que el servidor la confirme. Es
    // distinto de `client_mutation_id`: ese identifica el intento de
    // mutación (para el reintento idempotente), este identifica la tarea
    // en sí.
    id: idSchema,
    project_id: idSchema,
    parent_task_id: idSchema.optional(),
    title: z.string().min(1).max(200),
    description: z.string().max(4000).optional(),
    criticality: z.enum(['low', 'normal', 'high', 'critical']).optional(),
    assignee_member_id: memberIdSchema.optional(),
    planned_start_at: localDateTimeSchema.optional(),
    planned_end_at: localDateTimeSchema.optional(),
    is_milestone: z.boolean().optional(),
    ack_required: z.boolean().optional(),
  }),
);
export type CreateTaskInput = z.infer<typeof createTaskInputSchema>;

export const taskOutputSchema = z.object({
  id: idSchema,
  project_id: idSchema,
  parent_task_id: idSchema.nullable(),
  path: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  status: z.literal('pending'),
  criticality: z.enum(['low', 'normal', 'high', 'critical']),
  assignee_member_id: memberIdSchema.nullable(),
  planned_start_at: z.iso.datetime().nullable(),
  planned_end_at: z.iso.datetime().nullable(),
  is_milestone: z.boolean(),
  ack_required: z.boolean(),
  position: z.string(),
  version: z.int(),
  created_at: z.iso.datetime(),
});
export type TaskOutput = z.infer<typeof taskOutputSchema>;

/**
 * Sin `.errors()` propio: los tres casos de error de este slice
 * (proyecto inexistente, tarea padre inexistente, profundidad excedida)
 * son casos finos de `NOT_FOUND`/`UNPROCESSABLE_CONTENT`, que `base` ya
 * declara. `domain_code` (en `domainErrorData`) es lo que los distingue
 * (CLAUDE.md §8).
 */
export const createTaskContract = base
  .route({
    method: 'POST',
    path: '/projects/tasks',
    summary: 'Crea una tarea, opcionalmente como subtarea de otra',
    tags: ['projects'],
  })
  .input(createTaskInputSchema)
  .output(taskOutputSchema);
