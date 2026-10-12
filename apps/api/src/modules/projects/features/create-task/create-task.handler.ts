import { Injectable } from '@nestjs/common';
import type { TaskOutput } from '@orq/contracts';
import type { Tx } from '@orq/db';
import { hasCapability } from '../../../../shared/auth/access-control.js';
import { claimMutation } from '../../../../shared/database/mutation-log.js';
import { TransactionService } from '../../../../shared/database/transaction.service.js';
import { domainEvents } from '../../../../shared/domain-events/domain-events.js';
import type { TenantIdentity } from '../../../../shared/request-context/request-context.js';
import { getRequestContext } from '../../../../shared/request-context/request-context.js';
import { TenancyService } from '../../../tenancy/tenancy.module.js';
import { AssigneeNotAssignableError } from '../../domain/errors/assignee-not-assignable.error.js';
import { ParentTaskNotFoundError } from '../../domain/errors/parent-task-not-found.error.js';
import { ProjectNotFoundError } from '../../domain/errors/project-not-found.error.js';
import { TaskCreateForbiddenError } from '../../domain/errors/task-create-forbidden.error.js';
import { TaskCreateProjectAccessError } from '../../domain/errors/task-create-project-access.error.js';
import { TaskDatesIncoherentError } from '../../domain/errors/task-dates-incoherent.error.js';
import { TaskDepthExceededError } from '../../domain/errors/task-depth-exceeded.error.js';
import { TaskNotFoundError } from '../../domain/errors/task-not-found.error.js';
import { localDatetimeToUtc } from '../../domain/local-datetime-to-utc.js';
import { exceedsMaxTaskDepth } from '../../domain/max-task-depth.js';
import { plannedDatesAreCoherent } from '../../domain/task-patch.js';
import { nextTaskPosition } from '../../domain/task-position.js';
import {
  findLastSiblingPosition,
  findParentTaskForTenant,
  findProjectForTenant,
  findTaskById,
  insertTask,
  type TaskRow,
} from '../../infrastructure/task.repository.js';
import { toTaskOutput } from '../../infrastructure/task-output.mapper.js';
import { ProjectAccessService } from '../../project-access.service.js';
import { isAssignableToProject } from '../../project-assignment.js';
import type { CreateTaskCommand } from './create-task.command.js';

@Injectable()
export class CreateTaskHandler {
  constructor(
    private readonly transactions: TransactionService,
    private readonly tenancy: TenancyService,
    private readonly projectAccess: ProjectAccessService,
  ) {}

  async execute(command: CreateTaskCommand): Promise<TaskOutput> {
    const { requestId, tenant } = getRequestContext();
    if (!tenant) {
      throw new Error('create-task requiere una sesión con organización activa.');
    }

    const { task, created } = await this.transactions.withTenant((tx) =>
      this.applyMutation(command, tenant, tx),
    );

    // Después del commit, nunca desde dentro del callback: si la
    // transacción hiciera rollback, no hay que avisarle a nadie de algo
    // que no pasó (ADR-009). Un reintento idempotente no vuelve a emitir: no hay
    // efecto nuevo.
    if (created) {
      domainEvents.emitEvent('task.created', {
        taskId: task.id,
        organizationId: tenant.organizationId,
        projectId: task.projectId,
        requestId,
      });
    }

    return toTaskOutput(task);
  }

  private async applyMutation(
    command: CreateTaskCommand,
    tenant: TenantIdentity,
    tx: Tx,
  ): Promise<{ task: TaskRow; created: boolean }> {
    // Primera sentencia de la transacción: se reserva la mutación antes de leer
    // nada (ADR-007). Dos pedidos simultáneos con el mismo `client_mutation_id`
    // se serializan acá: el segundo espera, ve la mutación confirmada y devuelve
    // la tarea del primero, sin error ni reintento.
    const claim = await claimMutation(tx, {
      clientMutationId: command.client_mutation_id,
      organizationId: tenant.organizationId,
      memberId: tenant.memberId,
      kind: 'task.create',
      entityId: command.id,
    });
    if (!claim.claimed) {
      const existing = await findTaskById(tx, {
        organizationId: tenant.organizationId,
        taskId: claim.prior.entityId ?? command.id,
      });
      // Si ya no la ve (borrada, o le sacaron el acceso), no hay respuesta que reconstruir.
      if (!existing) throw new TaskNotFoundError(command.id);
      return { task: existing, created: false };
    }

    const project = await findProjectForTenant(tx, {
      organizationId: tenant.organizationId,
      projectId: command.project_id,
    });
    if (!project) throw new ProjectNotFoundError(command.project_id);

    // Orden fijo de ADR-017 §6: 404 → 403. El proyecto se busca ANTES de mirar
    // la capacidad, así quien no lo ve (un operator en un proyecto reservado
    // ajeno) recibe 404 y no un 403 que le confirme que existe.
    if (!hasCapability(tenant.role, { task: ['create'] })) {
      throw new TaskCreateForbiddenError();
    }

    // Crear tareas exige acceso completo. Ver el proyecto solo porque tiene una
    // tarea asignada no alcanza. La respuesta la da la base, no el código.
    if (!(await this.projectAccess.hasFullAccess(tx, { projectId: project.id }))) {
      throw new TaskCreateProjectAccessError();
    }

    if (command.assignee_member_id) {
      const assignable = await isAssignableToProject(
        { tenancy: this.tenancy, projectAccess: this.projectAccess },
        tx,
        {
          organizationId: tenant.organizationId,
          memberId: command.assignee_member_id,
          project,
        },
      );
      if (!assignable) throw new AssigneeNotAssignableError(command.assignee_member_id);
    }

    if (command.parent_task_id) {
      const parent = await findParentTaskForTenant(tx, {
        organizationId: tenant.organizationId,
        projectId: command.project_id,
        parentTaskId: command.parent_task_id,
      });
      if (!parent) throw new ParentTaskNotFoundError(command.parent_task_id);
      if (exceedsMaxTaskDepth(parent.depth)) {
        throw new TaskDepthExceededError(command.parent_task_id);
      }
    }

    const timeZone = await this.tenancy.resolveTimezone(tx, {
      organizationId: tenant.organizationId,
      siteId: project.siteId,
    });

    const plannedStartAtUtc = command.planned_start_at
      ? localDatetimeToUtc(command.planned_start_at, timeZone)
      : null;
    const plannedEndAtUtc = command.planned_end_at
      ? localDatetimeToUtc(command.planned_end_at, timeZone)
      : null;
    // La base lo impide con `task_dates_coherent_check`; sin esta validación el pedido
    // terminaba en un 500 opaco en vez de un motivo que el usuario pueda leer.
    if (!plannedDatesAreCoherent(plannedStartAtUtc, plannedEndAtUtc)) {
      throw new TaskDatesIncoherentError();
    }

    const lastPosition = await findLastSiblingPosition(tx, {
      organizationId: tenant.organizationId,
      projectId: command.project_id,
      parentTaskId: command.parent_task_id ?? null,
    });

    const created = await insertTask(tx, {
      id: command.id,
      organizationId: tenant.organizationId,
      createdByMemberId: tenant.memberId,
      projectId: command.project_id,
      parentTaskId: command.parent_task_id ?? null,
      title: command.title,
      description: command.description ?? null,
      criticality: command.criticality ?? 'normal',
      assigneeMemberId: command.assignee_member_id ?? null,
      plannedStartAtUtc,
      plannedEndAtUtc,
      isMilestone: command.is_milestone ?? false,
      ackRequired: command.ack_required ?? false,
      position: nextTaskPosition(lastPosition),
    });

    return { task: created, created: true };
  }
}
