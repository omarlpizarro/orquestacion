import { z } from 'zod';
import { base, withClientMutationId } from '../shared/base.contract.js';
import { idSchema } from '../shared/id.js';
import { memberIdSchema } from '../shared/member-id.js';

export const projectVisibilitySchema = z.enum(['reserved', 'site']);
export type ProjectVisibility = z.infer<typeof projectVisibilitySchema>;

// `project_status_check` en 0005_projects.sql. El CRUD de fase 2 no cambia el
// estado, pero el contrato lo expone desde ya por la misma razón que
// `taskStatusSchema`: un cliente integrado hoy tiene que aceptar los otros.
export const projectStatusSchema = z.enum(['planning', 'active', 'on_hold', 'archived']);

/**
 * `full`: acceso completo (ADR-017 §1). `assigned`: ve el proyecto solo porque
 * tiene una tarea asignada; recibe el DTO reducido (sin descripción), porque RLS
 * filtra filas, no columnas.
 */
export const projectAccessLevelSchema = z.enum(['full', 'assigned']);

export const projectOutputSchema = z.object({
  id: idSchema,
  site_id: idSchema,
  code: z.string(),
  name: z.string(),
  // `null` también cuando `access_level` es `assigned`: ese nivel no ve la descripción.
  description: z.string().nullable(),
  status: projectStatusSchema,
  visibility: projectVisibilitySchema,
  access_level: projectAccessLevelSchema,
  created_by_member_id: memberIdSchema,
  version: z.int(),
  created_at: z.iso.datetime(),
});
export type ProjectOutput = z.infer<typeof projectOutputSchema>;

export const createProjectInputSchema = withClientMutationId(
  z.object({
    // UUIDv7 generado en el cliente (CLAUDE.md regla dura 6), distinto de
    // `client_mutation_id`. Nunca se manda `created_at` ni `version`: la
    // adenda del ADR-017 depende de que vengan del default de la base.
    id: idSchema,
    // Opcional: en una organización con un solo sitio se toma ese. Con más de
    // uno es obligatorio y pasa por `canAccessSite` como en `create-task`.
    site_id: idSchema.optional(),
    code: z.string().trim().min(1).max(40),
    name: z.string().trim().min(1).max(200),
    description: z.string().max(4000).optional(),
    // `reserved` por defecto (ADR-017).
    visibility: projectVisibilitySchema.optional(),
  }),
);
export type CreateProjectInput = z.infer<typeof createProjectInputSchema>;

/**
 * Sin `.errors()` propio: los casos de este slice (rol sin permiso, sitio
 * inexistente o sin acceso, sitio a elegir, código repetido) son
 * FORBIDDEN/UNPROCESSABLE_CONTENT/CONFLICT, ya declarados en `base`;
 * `domain_code` los distingue (CLAUDE.md §8).
 */
export const createProjectContract = base
  .route({
    method: 'POST',
    path: '/projects',
    summary: 'Crea un proyecto; el creador queda como miembro explícito',
    tags: ['projects'],
  })
  .input(createProjectInputSchema)
  .output(projectOutputSchema);
