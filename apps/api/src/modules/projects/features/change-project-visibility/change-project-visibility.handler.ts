import { Injectable } from '@nestjs/common';
import type { ProjectOutput } from '@orq/contracts';
import type { Tx } from '@orq/db';
import { hasCapability } from '../../../../shared/auth/access-control.js';
import { claimMutation } from '../../../../shared/database/mutation-log.js';
import { TransactionService } from '../../../../shared/database/transaction.service.js';
import {
  getRequestContext,
  type TenantIdentity,
} from '../../../../shared/request-context/request-context.js';
import { ProjectNotFoundError } from '../../domain/errors/project-not-found.error.js';
import { ProjectVersionMismatchError } from '../../domain/errors/project-version-mismatch.error.js';
import { ProjectVisibilityChangeForbiddenError } from '../../domain/errors/project-visibility-change-forbidden.error.js';
import { canManageProject } from '../../domain/project-permissions.js';
import {
  findProjectById,
  type ProjectRow,
  updateProjectVisibility,
} from '../../infrastructure/project.repository.js';
import { toProjectOutput } from '../../infrastructure/project-output.mapper.js';
import type { ChangeProjectVisibilityCommand } from './change-project-visibility.command.js';

@Injectable()
export class ChangeProjectVisibilityHandler {
  constructor(private readonly transactions: TransactionService) {}

  async execute(command: ChangeProjectVisibilityCommand): Promise<ProjectOutput> {
    const { tenant } = getRequestContext();
    if (!tenant) {
      throw new Error('change-project-visibility requiere una sesión con organización activa.');
    }

    const project = await this.transactions.withTenant((tx) =>
      this.applyMutation(command, tenant, tx),
    );
    return toProjectOutput(project);
  }

  private async applyMutation(
    command: ChangeProjectVisibilityCommand,
    tenant: TenantIdentity,
    tx: Tx,
  ): Promise<ProjectRow> {
    const { organizationId, memberId } = tenant;
    const target = { organizationId, projectId: command.project_id };

    // Primera sentencia de la transacción: se reserva la mutación antes de leer
    // el proyecto (ADR-007). Con el orden viejo, un pedido duplicado leía la
    // versión ya cambiada por el primero y respondía 409 en vez de su respuesta.
    const claim = await claimMutation(tx, {
      clientMutationId: command.client_mutation_id,
      organizationId,
      memberId,
      kind: 'project.change_visibility',
      entityId: command.project_id,
    });
    if (!claim.claimed) {
      const existing = await findProjectById(tx, target);
      if (!existing) throw new ProjectNotFoundError(command.project_id);
      return existing;
    }

    // Orden fijo de ADR-017 §6: 404 → 403 → versión (409). La autorización va
    // antes de la versión para no contarle a quien no puede tocar el proyecto
    // que cambió.
    const project = await findProjectById(tx, target);
    if (!project) throw new ProjectNotFoundError(command.project_id);

    const allowed = canManageProject({
      hasFullAccess: project.fullAccess,
      hasRoleCapability: hasCapability(tenant.role, { project: ['change_visibility'] }),
      isCreator: project.createdByMemberId === memberId,
    });
    if (!allowed) throw new ProjectVisibilityChangeForbiddenError();

    if (project.version !== command.expected_version) {
      throw new ProjectVersionMismatchError(command.project_id, command.expected_version);
    }

    // Pedir la visibilidad que ya tiene no es un error ni un cambio: no se
    // escribe (el trigger de auditoría no registra algo que no pasó).
    if (project.visibility !== command.visibility) {
      const updated = await updateProjectVisibility(tx, {
        ...target,
        visibility: command.visibility,
        expectedVersion: command.expected_version,
      });
      // Falla solo si alguien ganó la carrera entre el SELECT y este UPDATE.
      if (!updated) {
        throw new ProjectVersionMismatchError(command.project_id, command.expected_version);
      }
    }

    const changed = await findProjectById(tx, target);
    if (!changed) throw new ProjectNotFoundError(command.project_id);
    return changed;
  }
}
