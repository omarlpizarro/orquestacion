import type { ProjectOutput } from '@orq/contracts';
import type { ProjectRow } from './project.repository.js';

/**
 * Único lugar que traduce `ProjectRow` a la forma pública. Para el nivel "solo
 * asignado" el DTO es reducido (ADR-017, Consecuencias): RLS filtra filas, no
 * columnas, así que la descripción se quita acá.
 */
export function toProjectOutput(project: ProjectRow): ProjectOutput {
  return {
    id: project.id,
    site_id: project.siteId,
    code: project.code,
    name: project.name,
    description: project.fullAccess ? project.description : null,
    status: project.status as ProjectOutput['status'],
    visibility: project.visibility as ProjectOutput['visibility'],
    access_level: project.fullAccess ? 'full' : 'assigned',
    created_by_member_id: project.createdByMemberId,
    version: project.version,
    created_at: project.createdAt,
  };
}
