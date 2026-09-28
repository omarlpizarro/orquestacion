import { z } from 'zod';
import { base } from '../shared/base.contract.js';
import { ianaTimeZoneSchema } from '../shared/time-zone.js';
import { taskOutputSchema } from './create-task.contract.js';

/**
 * Mutuamente excluyente. Prioridad de clasificación (docs/phase-2-brief.md,
 * "Mi Día"): `blocked` > `overdue` > `today` > `undated` — una tarea vencida
 * Y bloqueada cae en `blocked`, con `is_overdue: true` para no perder el
 * dato de que además está vencida. El orden de las secciones en pantalla es
 * otro: vencidas, hoy, bloqueadas, sin fecha (mismo orden que este enum).
 */
export const myDaySectionSchema = z.enum(['overdue', 'today', 'blocked', 'undated']);
export type MyDaySection = z.infer<typeof myDaySectionSchema>;

export const myDayInputSchema = z.object({
  // Zona horaria de quien consulta, no la del sitio de la tarea (esa ya se
  // usó para convertir planned_start_at/planned_end_at a UTC al crear la
  // tarea, ver ADR-008). Sin esto, "hoy" se resuelve con
  // organization_profile.timezone.
  time_zone: ianaTimeZoneSchema.optional(),
});
export type MyDayInput = z.infer<typeof myDayInputSchema>;

export const myDayTaskOutputSchema = taskOutputSchema.extend({
  section: myDaySectionSchema,
  is_overdue: z.boolean(),
});
export type MyDayTaskOutput = z.infer<typeof myDayTaskOutputSchema>;

export const myDayOutputSchema = z.object({
  tasks: z.array(myDayTaskOutputSchema),
});
export type MyDayOutput = z.infer<typeof myDayOutputSchema>;

/**
 * Lectura, no lleva `client_mutation_id` (CLAUDE.md §9 es para escrituras).
 * Sin `.errors()` propio: no hay casos de dominio finos acá, solo la sesión
 * con organización activa que ya exige el middleware de tenant.
 */
export const myDayContract = base
  .route({
    method: 'GET',
    path: '/projects/tasks/my-day',
    summary: 'Lista las tareas del día del miembro autenticado',
    tags: ['projects'],
  })
  .input(myDayInputSchema)
  .output(myDayOutputSchema);
