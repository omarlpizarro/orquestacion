import { Injectable } from '@nestjs/common';
import { type AddProjectMemberOutput, newId } from '@orq/contracts';
import type { Tx } from '@orq/db';
import { hasCapability } from '../../../../shared/auth/access-control.js';
import { claimMutation } from '../../../../shared/database/mutation-log.js';
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
import { findProjectById, insertProjectMember } from '../../infrastructure/project.repository.js';
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

    await this.transactions.withTenant((tx) => this.applyMutation(command, tenant, tx));

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

    // Primera sentencia de la transacción (ADR-007): dos pedidos simultáneos con
    // el mismo `client_mutation_id` se serializan acá, y el segundo no repite nada.
    const claim = await claimMutation(tx, {
      clientMutationId: command.client_mutation_id,
      organizationId,
      memberId,
      kind: 'project.add_member',
      entityId: command.project_id,
    });
    if (!claim.claimed) return;

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

    // Agregar a quien ya es miembro no es un error. Dos pedidos DISTINTOS (con
    // otro `client_mutation_id`) que lo agregan a la vez no chocan: el
    // `INSERT ... ON CONFLICT DO NOTHING` sobre el índice único parcial deja pasar
    // a uno y el otro no hace nada.
    await insertProjectMember(tx, {
      id: newId(),
      organizationId,
      createdByMemberId: memberId,
      projectId: command.project_id,
      memberId: command.member_id,
    });
  }
}
