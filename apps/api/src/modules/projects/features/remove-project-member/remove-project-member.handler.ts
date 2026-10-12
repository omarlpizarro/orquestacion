import { Injectable } from '@nestjs/common';
import type { RemoveProjectMemberOutput } from '@orq/contracts';
import type { Tx } from '@orq/db';
import { hasCapability } from '../../../../shared/auth/access-control.js';
import { claimMutation } from '../../../../shared/database/mutation-log.js';
import { TransactionService } from '../../../../shared/database/transaction.service.js';
import {
  getRequestContext,
  type TenantIdentity,
} from '../../../../shared/request-context/request-context.js';
import { ProjectCreatorRemovalForbiddenError } from '../../domain/errors/project-creator-removal-forbidden.error.js';
import { ProjectMemberNotFoundError } from '../../domain/errors/project-member-not-found.error.js';
import { ProjectMembersManageForbiddenError } from '../../domain/errors/project-members-manage-forbidden.error.js';
import { ProjectNotFoundError } from '../../domain/errors/project-not-found.error.js';
import { decideMemberRemoval } from '../../domain/project-permissions.js';
import {
  countAssignedTasks,
  findProjectById,
  isActiveProjectMember,
  softDeleteProjectMember,
} from '../../infrastructure/project.repository.js';
import type { RemoveProjectMemberCommand } from './remove-project-member.command.js';

@Injectable()
export class RemoveProjectMemberHandler {
  constructor(private readonly transactions: TransactionService) {}

  async execute(command: RemoveProjectMemberCommand): Promise<RemoveProjectMemberOutput> {
    const { tenant } = getRequestContext();
    if (!tenant) {
      throw new Error('remove-project-member requiere una sesión con organización activa.');
    }

    const remaining = await this.transactions.withTenant((tx) =>
      this.applyMutation(command, tenant, tx),
    );
    return {
      project_id: command.project_id,
      member_id: command.member_id,
      remaining_assigned_task_count: remaining,
    };
  }

  /** Devuelve cuántas tareas le quedan asignadas al miembro quitado. */
  private async applyMutation(
    command: RemoveProjectMemberCommand,
    tenant: TenantIdentity,
    tx: Tx,
  ): Promise<number> {
    const { organizationId, memberId } = tenant;
    const target = {
      organizationId,
      projectId: command.project_id,
      memberId: command.member_id,
    };

    // Primera sentencia de la transacción (ADR-007). Un reintento recalcula el
    // conteo (lo que quedó asignado, visible para quien pregunta) en vez de
    // guardarlo: la respuesta no se desactualiza.
    const claim = await claimMutation(tx, {
      clientMutationId: command.client_mutation_id,
      organizationId,
      memberId,
      kind: 'project.remove_member',
      entityId: command.project_id,
    });
    if (!claim.claimed) return countAssignedTasks(tx, target);

    // 404 → 403 (ADR-017 §6).
    const project = await findProjectById(tx, { organizationId, projectId: command.project_id });
    if (!project) throw new ProjectNotFoundError(command.project_id);

    const decision = decideMemberRemoval({
      hasFullAccess: project.fullAccess,
      hasRoleCapability: hasCapability(tenant.role, { project: ['manage_members'] }),
      isCreator: project.createdByMemberId === memberId,
      actorMemberId: memberId,
      creatorMemberId: project.createdByMemberId,
      targetMemberId: command.member_id,
    });
    if (decision === 'creator_removal_forbidden') throw new ProjectCreatorRemovalForbiddenError();
    if (decision === 'forbidden') throw new ProjectMembersManageForbiddenError();

    if (!(await isActiveProjectMember(tx, target))) throw new ProjectMemberNotFoundError();

    // Quitar a alguien no toca sus tareas (ADR-017 §8): se cuentan antes, con el
    // acceso de quien lo quita (que puede perder el suyo si se saca a sí mismo).
    const remaining = await countAssignedTasks(tx, target);
    if (!(await softDeleteProjectMember(tx, target))) throw new ProjectMemberNotFoundError();

    return remaining;
  }
}
