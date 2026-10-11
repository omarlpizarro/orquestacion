import { Injectable } from '@nestjs/common';
import { type AddProjectMemberOutput, newId } from '@orq/contracts';
import type { Tx } from '@orq/db';
import { hasCapability } from '../../../../shared/auth/access-control.js';
import { findPriorMutation, recordMutation } from '../../../../shared/database/mutation-log.js';
import { retryOnceOnUniqueViolation } from '../../../../shared/database/postgres-errors.js';
import { TransactionService } from '../../../../shared/database/transaction.service.js';
import {
  getRequestContext,
  type TenantIdentity,
} from '../../../../shared/request-context/request-context.js';
import { TenancyService } from '../../../tenancy/tenancy.module.js';
import { ProjectMemberNotInOrganizationError } from '../../domain/errors/project-member-not-in-organization.error.js';
import { ProjectMembersManageForbiddenError } from '../../domain/errors/project-members-manage-forbidden.error.js';
import { ProjectNotFoundError } from '../../domain/errors/project-not-found.error.js';
import { canManageProject } from '../../domain/project-permissions.js';
import {
  findProjectById,
  insertProjectMember,
  isActiveProjectMember,
} from '../../infrastructure/project.repository.js';
import type { AddProjectMemberCommand } from './add-project-member.command.js';

@Injectable()
export class AddProjectMemberHandler {
  constructor(
    private readonly transactions: TransactionService,
    private readonly tenancy: TenancyService,
  ) {}

  async execute(command: AddProjectMemberCommand): Promise<AddProjectMemberOutput> {
    const { tenant } = getRequestContext();
    if (!tenant) {
      throw new Error('add-project-member requiere una sesión con organización activa.');
    }

    await retryOnceOnUniqueViolation(() =>
      this.transactions.withTenant((tx) => this.applyMutation(command, tenant, tx)),
    );

    // La respuesta se arma del pedido, no de una fila: un reintento tiene que
    // devolver exactamente lo mismo.
    return { project_id: command.project_id, member_id: command.member_id };
  }

  private async applyMutation(
    command: AddProjectMemberCommand,
    tenant: TenantIdentity,
    tx: Tx,
  ): Promise<void> {
    const { organizationId, memberId } = tenant;

    const prior = await findPriorMutation(tx, command.client_mutation_id);
    if (prior?.result === 'applied') return;

    // 404 → 403 (ADR-017 §6).
    const project = await findProjectById(tx, { organizationId, projectId: command.project_id });
    if (!project) throw new ProjectNotFoundError(command.project_id);

    const allowed = canManageProject({
      hasFullAccess: project.fullAccess,
      hasRoleCapability: hasCapability(tenant.role, { project: ['manage_members'] }),
      isCreator: project.createdByMemberId === memberId,
    });
    if (!allowed) throw new ProjectMembersManageForbiddenError();

    // Cualquier miembro de la organización, sin requisito de acceso al sitio (ADR-017 §8).
    const inOrganization = await this.tenancy.isMemberInOrganization(tx, {
      organizationId,
      memberId: command.member_id,
    });
    if (!inOrganization) throw new ProjectMemberNotInOrganizationError();

    // Agregar a quien ya es miembro no es un error. Si dos pedidos distintos lo
    // agregan a la vez, el índice único parcial deja pasar a uno y el otro
    // reintenta (arriba) y lo encuentra.
    const alreadyMember = await isActiveProjectMember(tx, {
      organizationId,
      projectId: command.project_id,
      memberId: command.member_id,
    });
    if (!alreadyMember) {
      await insertProjectMember(tx, {
        id: newId(),
        organizationId,
        createdByMemberId: memberId,
        projectId: command.project_id,
        memberId: command.member_id,
      });
    }

    await recordMutation(tx, {
      clientMutationId: command.client_mutation_id,
      organizationId,
      memberId,
      kind: 'project.add_member',
      entityId: command.project_id,
      result: 'applied',
    });
  }
}
