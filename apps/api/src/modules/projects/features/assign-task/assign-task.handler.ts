import { Injectable } from '@nestjs/common';
import type { TaskOutput } from '@orq/contracts';
import type { Tx } from '@orq/db';
import { hasCapability } from '../../../../shared/auth/access-control.js';
import { claimMutation } from '../../../../shared/database/mutation-log.js';
import { TransactionService } from '../../../../shared/database/transaction.service.js';
import { domainEvents } from '../../../../shared/domain-events/domain-events.js';
import {
  getRequestContext,
  type TenantIdentity,
} from '../../../../shared/request-context/request-context.js';
import { TenancyService } from '../../../tenancy/tenancy.module.js';
import { AssigneeNotAssignableError } from '../../domain/errors/assignee-not-assignable.error.js';
import { ProjectNotFoundError } from '../../domain/errors/project-not-found.error.js';
import { TaskAssignCancelledError } from '../../domain/errors/task-assign-cancelled.error.js';
import { TaskAssignForbiddenError } from '../../domain/errors/task-assign-forbidden.error.js';
import { TaskAssignProjectAccessError } from '../../domain/errors/task-assign-project-access.error.js';
import { TaskNotFoundError } from '../../domain/errors/task-not-found.error.js';
import { TaskVersionMismatchError } from '../../domain/errors/task-version-mismatch.error.js';
import { isTaskFrozenForEdit } from '../../domain/task-patch.js';
import {
  findProjectForTenant,
  findVisibleTask,
  type TaskRow,
  updateTaskAssignee,
} from '../../infrastructure/task.repository.js';
import { toTaskOutput } from '../../infrastructure/task-output.mapper.js';
import { ProjectAccessService } from '../../project-access.service.js';
import { isAssignableToProject } from '../../project-assignment.js';
import type { AssignTaskCommand } from './assign-task.command.js';

interface AssignOutcome {
  task: TaskRow;
  /** `true` solo si esta llamada cambió el responsable (no en un reintento ni si ya era ese). */
  changed: boolean;
  previousAssigneeMemberId: string | null;
}

@Injectable()
export class AssignTaskHandler {
  constructor(
    private readonly transactions: TransactionService,
    private readonly tenancy: TenancyService,
    private readonly projectAccess: ProjectAccessService,
  ) {}

  async execute(command: AssignTaskCommand): Promise<TaskOutput> {
    const { requestId, tenant } = getRequestContext();
    if (!tenant) {
      throw new Error('assign-task requiere una sesión con organización activa.');
    }

    const { task, changed, previousAssigneeMemberId } = await this.transactions.withTenant((tx) =>
      this.applyMutation(command, tenant, tx),
    );

    // Después del commit, nunca desde dentro del callback (ADR-009). Un reintento o pedir
    // el responsable que ya tiene no cambió nada: no hay evento (ni, más adelante, aviso).
    if (changed) {
      domainEvents.emitEvent('task.assigned', {
        taskId: task.id,
        organizationId: tenant.organizationId,
        projectId: task.projectId,
        assigneeMemberId: task.assigneeMemberId,
        previousAssigneeMemberId,
        assignedByMemberId: tenant.memberId,
        requestId,
      });
    }

    return toTaskOutput(task);
  }

  private async applyMutation(
    command: AssignTaskCommand,
    tenant: TenantIdentity,
    tx: Tx,
  ): Promise<AssignOutcome> {
    const { organizationId, memberId } = tenant;

    // Primera sentencia de la transacción: se reserva la mutación antes de leer la
    // tarea (ADR-007).
    const claim = await claimMutation(tx, {
      clientMutationId: command.client_mutation_id,
      organizationId,
      memberId,
      kind: 'task.assign',
      entityId: command.id,
    });
    if (!claim.claimed) {
      const existing = await findVisibleTask(tx, { organizationId, taskId: command.id });
      // Si ya no la ve (le sacaron el acceso, o la borraron), no hay respuesta que reconstruir.
      if (!existing) throw new TaskNotFoundError(command.id);
      return { task: existing, changed: false, previousAssigneeMemberId: null };
    }

    // Orden fijo de ADR-017 §6: 404 → 403 → reglas de dominio → 409.
    const current = await findVisibleTask(tx, { organizationId, taskId: command.id });
    if (!current) throw new TaskNotFoundError(command.id);

    // Asigna el rol con `task:assign` (owner, director, manager) y solo con acceso
    // completo al proyecto; el operario no, ni sobre su propia tarea. La respuesta sobre
    // el acceso la da la base.
    if (!hasCapability(tenant.role, { task: ['assign'] })) throw new TaskAssignForbiddenError();
    if (!(await this.projectAccess.hasFullAccess(tx, { projectId: current.projectId }))) {
      throw new TaskAssignProjectAccessError();
    }

    // Una cancelada está congelada (ADR-012), sea cual sea el pedido.
    if (isTaskFrozenForEdit(current.status)) throw new TaskAssignCancelledError();

    // Después de autorizar, a propósito: un 409 le diría a quien no puede tocar la tarea
    // que existe y que cambió. En las asignaciones gana el servidor (CLAUDE.md §9): una
    // versión vieja se rechaza, nunca se mezcla.
    if (current.version !== command.expected_version) {
      throw new TaskVersionMismatchError(command.id, command.expected_version);
    }

    const previousAssigneeMemberId = current.assigneeMemberId;
    // Pedir el responsable que ya tiene no cambia nada: no escribe (no sube la versión
    // ni deja una entrada vacía en el audit) y no avisa. La reserva de la mutación sí queda.
    if (command.assignee_member_id === previousAssigneeMemberId) {
      return { task: current, changed: false, previousAssigneeMemberId };
    }

    if (command.assignee_member_id !== null) {
      const project = await findProjectForTenant(tx, {
        organizationId,
        projectId: current.projectId,
      });
      if (!project) throw new ProjectNotFoundError(current.projectId);
      const assignable = await isAssignableToProject(
        { tenancy: this.tenancy, projectAccess: this.projectAccess },
        tx,
        { organizationId, memberId: command.assignee_member_id, project },
      );
      if (!assignable) throw new AssigneeNotAssignableError(command.assignee_member_id);
    }

    const updated = await updateTaskAssignee(tx, {
      organizationId,
      taskId: command.id,
      expectedVersion: command.expected_version,
      assigneeMemberId: command.assignee_member_id,
    });
    // `current` confirmó que la tarea existe: si acá vuelve vacío es porque alguien más
    // ganó la carrera entre esa lectura y este `UPDATE ... WHERE version = $esperado`.
    if (!updated) throw new TaskVersionMismatchError(command.id, command.expected_version);

    return { task: updated, changed: true, previousAssigneeMemberId };
  }
}
