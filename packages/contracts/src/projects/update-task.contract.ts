import { z } from 'zod';
import { base, withClientMutationId } from '../shared/base.contract.js';
import { idSchema } from '../shared/id.js';
import { localDateTimeSchema } from '../shared/local-datetime.js';
import { taskOutputSchema } from './create-task.contract.js';

/**
 * Los campos editables. Todos opcionales: se cambia solo lo que viene en el pedido.
 * `null` borra el valor (descripción y fechas planificadas); el título y la
 * criticidad no se pueden dejar vacíos.
 */
const editableFields = {
  title: z.string().trim().min(1).max(200).optional(),
  description: z.string().trim().max(4000).nullable().optional(),
  criticality: z.enum(['low', 'normal', 'high', 'critical']).optional(),
  // Hora de pared del sitio del proyecto, sin zona horaria (ADR-008), igual que al crear.
  planned_start_at: localDateTimeSchema.nullable().optional(),
  planned_end_at: localDateTimeSchema.nullable().optional(),
} as const;

export const editableTaskFields = Object.keys(editableFields) as Array<keyof typeof editableFields>;

export const updateTaskInputSchema = withClientMutationId(
  z.object({
    // Path param (`{id}`, ruta compacta de oRPC: CLAUDE.md §8 / ADR-005), igual que
    // `change-task-status`.
    id: idSchema,
    // Concurrencia optimista (docs/data-model.md, "Concurrencia"): obligatoria. Si no
    // coincide con la de la base se rechaza con 409 en vez de pisar un cambio ajeno;
    // en las fechas manda el servidor (CLAUDE.md §9), nunca se mezcla.
    expected_version: z.int().min(1),
    ...editableFields,
  }),
).refine((input) => editableTaskFields.some((field) => input[field] !== undefined), {
  message: 'Hay que mandar al menos un campo para editar.',
});
export type UpdateTaskInput = z.infer<typeof updateTaskInputSchema>;

/**
 * Edición parcial de una tarea. **No toca** el estado (`change-task-status`) ni el
 * responsable (`assign-task`): si vienen en el pedido se ignoran. Sin `.errors()`
 * propio: 404 si no existe o quien pide no la ve, 403 si la ve pero no puede
 * editarla, 409 por versión, 422 por fechas incoherentes; `base` los declara y
 * `domain_code` los distingue (CLAUDE.md §8). Devuelve la tarea.
 */
export const updateTaskContract = base
  .route({
    method: 'PATCH',
    path: '/projects/tasks/{id}',
    summary:
      'Edita el título, la descripción, la criticidad o las fechas planificadas de una tarea',
    tags: ['projects'],
  })
  .input(updateTaskInputSchema)
  .output(taskOutputSchema);
