import { Injectable } from '@nestjs/common';
import type { DeleteTaskOutput } from '@orq/contracts';
import type { Tx } from '@orq/db';
import { hasCapability } from '../../../../shared/auth/access-control.js';
import { claimMutation } from '../../../../shared/database/mutation-log.js';
import { TransactionService } from '../../../../shared/database/transaction.service.js';
import { domainEvents } from '../../../../shared/domain-events/domain-events.js';
import {
  getRequestContext,
  type TenantIdentity,
} from '../../../../shared/request-context/request-context.js';
import { TaskDeleteForbiddenError } from '../../domain/errors/task-delete-forbidden.error.js';
import { TaskDeleteProjectAccessError } from '../../domain/errors/task-delete-project-access.error.js';
import { TaskNotFoundError } from '../../domain/errors/task-not-found.error.js';
import { TaskVersionMismatchError } from '../../domain/errors/task-version-mismatch.error.js';
import {
  findDeletedTaskSummary,
  findVisibleTask,
  lockTaskSubtree,
  softDeleteTaskSubtree,
} from '../../infrastructure/task.repository.js';
import { ProjectAccessService } from '../../project-access.service.js';
import type { DeleteTaskCommand } from './delete-task.command.js';

interface DeleteOutcome {
  output: DeleteTaskOutput;
  /** `null` en un reintento: no hay efecto nuevo ni evento que emitir. */
  projectId: string | null;
}

@Injectable()
export class DeleteTaskHandler {
  constructor(
    private readonly transactions: TransactionService,
    private readonly projectAccess: ProjectAccessService,
  ) {}

  async execute(command: DeleteTaskCommand): Promise<DeleteTaskOutput> {
    const { requestId, tenant } = getRequestContext();
    if (!tenant) {
      throw new Error('delete-task requiere una sesión con organización activa.');
    }

    const { output, projectId } = await this.transactions.withTenant((tx) =>
      this.applyMutation(command, tenant, tx),
    );

    // Después del commit, nunca desde dentro del callback (ADR-009).
    if (projectId) {
      domainEvents.emitEvent('task.deleted', {
        taskId: output.id,
        organizationId: tenant.organizationId,
        projectId,
        deletedTaskCount: output.deleted_task_count,
        deletedByMemberId: tenant.memberId,
        requestId,
      });
    }

    return output;
  }

  private async applyMutation(
    command: DeleteTaskCommand,
    tenant: TenantIdentity,
    tx: Tx,
  ): Promise<DeleteOutcome> {
    const { organizationId, memberId } = tenant;

    // Primera sentencia de la transacción: se reserva la mutación antes de leer la
    // tarea (ADR-007).
    const claim = await claimMutation(tx, {
      clientMutationId: command.client_mutation_id,
      organizationId,
      memberId,
      kind: 'task.delete',
      entityId: command.id,
    });
    if (!claim.claimed) {
      // La tarea ya no se ve (está borrada), así que la respuesta se reconstruye de lo
      // que quedó en la base. Si quien reintenta ya no tiene acceso, 404.
      const summary = await findDeletedTaskSummary(tx, { organizationId, taskId: command.id });
      if (!summary) throw new TaskNotFoundError(command.id);
      return {
        output: {
          id: command.id,
          deleted_at: summary.deletedAt,
          deleted_task_count: summary.count,
        },
        projectId: null,
      };
    }

    // Orden fijo de ADR-017 §6: 404 → 403 → 409.
    const current = await findVisibleTask(tx, { organizationId, taskId: command.id });
    if (!current) throw new TaskNotFoundError(command.id);

    // Borra el rol con `task:delete` (owner, director, manager) y solo con acceso
    // completo al proyecto: borrar un árbol entero no se le deja a quien ve el proyecto
    // por una tarea asignada. La respuesta sobre el acceso la da la base.
    if (!hasCapability(tenant.role, { task: ['delete'] })) throw new TaskDeleteForbiddenError();
    if (!(await this.projectAccess.hasFullAccess(tx, { projectId: current.projectId }))) {
      throw new TaskDeleteProjectAccessError();
    }

    // Después de autorizar, a propósito: un 409 le diría a quien no puede tocar la tarea
    // que existe y que cambió.
    if (current.version !== command.expected_version) {
      throw new TaskVersionMismatchError(command.id, command.expected_version);
    }

    // Se bloquea el árbol entero antes de tocarlo. Es lo que hace esperar a quien esté
    // colgando una subtarea o editando alguna del árbol. La versión se vuelve a mirar ya
    // con el bloqueo tomado: entre la lectura de arriba y acá alguien pudo editarla.
    const locked = await lockTaskSubtree(tx, { organizationId, taskId: command.id });
    const root = locked.find((task) => task.id === command.id);
    if (!root) throw new TaskNotFoundError(command.id);
    if (root.version !== command.expected_version) {
      throw new TaskVersionMismatchError(command.id, command.expected_version);
    }

    const { count, deletedAt } = await softDeleteTaskSubtree(tx, {
      organizationId,
      taskId: command.id,
    });

    return {
      output: { id: command.id, deleted_at: deletedAt, deleted_task_count: count },
      projectId: current.projectId,
    };
  }
}
