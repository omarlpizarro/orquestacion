import type { Tx } from '@orq/db';
import type { TenancyService } from '../tenancy/tenancy.module.js';
import type { ProjectAccessService } from './project-access.service.js';

/**
 * ADR-017 §8: se le puede asignar una tarea de un proyecto a quien existe en la
 * organización y puede trabajar en el sitio del proyecto con **su propio rol**
 * (`canAccessSite`, leído de `auth.member`), o es miembro explícito del proyecto
 * (haberlo agregado es una decisión deliberada que pesa más que el sitio).
 *
 * Una sola definición para `create-task` y `assign-task`: dos copias de esta regla
 * se desincronizan. `false` tanto si no es de la organización como si no trabaja en
 * el sitio: quien llama no necesita distinguirlos, y distinguirlos le diría a quien
 * asigna si un id ajeno corresponde a un miembro de otro tenant.
 */
export async function isAssignableToProject(
  services: { tenancy: TenancyService; projectAccess: ProjectAccessService },
  tx: Tx,
  params: { organizationId: string; memberId: string; project: { id: string; siteId: string } },
): Promise<boolean> {
  const { tenancy, projectAccess } = services;
  const { organizationId, memberId, project } = params;

  if (await tenancy.isMemberAssignable(tx, { organizationId, memberId, siteId: project.siteId })) {
    return true;
  }
  return (
    (await projectAccess.isExplicitMember(tx, {
      organizationId,
      projectId: project.id,
      memberId,
    })) && (await tenancy.isMemberInOrganization(tx, { organizationId, memberId }))
  );
}
