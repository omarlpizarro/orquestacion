import { Injectable } from '@nestjs/common';
import type { TaskOutput } from '@orq/contracts';
import type { Tx } from '@orq/db';
import { hasCapability } from '../../../../shared/auth/access-control.js';
import { findPriorMutation, recordMutation } from '../../../../shared/database/mutation-log.js';
import {
  hasPostgresErrorCode,
  UNIQUE_VIOLATION,
} from '../../../../shared/database/postgres-errors.js';
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
import { TaskDepthExceededError } from '../../domain/errors/task-depth-exceeded.error.js';
import { localDatetimeToUtc } from '../../domain/local-datetime-to-utc.js';
import { exceedsMaxTaskDepth } from '../../domain/max-task-depth.js';
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

    const task = await this.createOrReplayMutation(command, tenant);

    // Después del commit, nunca desde dentro del callback: si la
    // transacción hiciera rollback, no hay que avisarle a nadie de algo
    // que no pasó (ADR-009).
    domainEvents.emitEvent('task.created', {
      taskId: task.id,
      organizationId: tenant.organizationId,
      projectId: task.projectId,
      requestId,
    });

    return toTaskOutput(task);
  }

  /**
   * Dos agujeros de idempotencia si esto fuera una sola pasada: (1)
   * `mutation_log` dice "aplicada" pero la tarea que apunta ya no está —
   * seguiríamos de largo e intentaríamos insertar nuevo; (2) dos requests
   * con el mismo `client_mutation_id` a la vez, ninguno ve la mutación del
   * otro todavía, los dos intentan insertar. En ambos casos el efecto no
   * se duplica (la PK de `task`/`mutation_log` lo impide), pero sin este
   * catch el que pierde la carrera recibía un 500 opaco en vez del mismo
   * resultado que el que ganó.
   */
  private async createOrReplayMutation(
    command: CreateTaskCommand,
    tenant: TenantIdentity,
  ): Promise<TaskRow> {
    try {
      return await this.transactions.withTenant((tx) => this.applyMutation(command, tenant, tx));
    } catch (error) {
      if (!hasPostgresErrorCode(error, UNIQUE_VIOLATION)) throw error;

      const replayed = await this.transactions.withTenant(async (tx) => {
        const prior = await findPriorMutation(tx, command.client_mutation_id);
        if (!prior?.entityId) return null;
        return findTaskById(tx, { organizationId: tenant.organizationId, taskId: prior.entityId });
      });
      // Si no hay mutación previa resuelta, la violación de unicidad era
      // por otra cosa (o de verdad hay una carrera que este reintento
      // todavía no ve) — no la disfrazamos, se relanza la original.
      if (!replayed) throw error;
      return replayed;
    }
  }

  private async applyMutation(
    command: CreateTaskCommand,
    tenant: TenantIdentity,
    tx: Tx,
  ): Promise<TaskRow> {
    const prior = await findPriorMutation(tx, command.client_mutation_id);
    if (prior?.result === 'applied' && prior.entityId) {
      const existing = await findTaskById(tx, {
        organizationId: tenant.organizationId,
        taskId: prior.entityId,
      });
      if (existing) return existing;
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
      const assignable = await this.isAssignable(tx, {
        organizationId: tenant.organizationId,
        memberId: command.assignee_member_id,
        project,
      });
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
      plannedStartAtUtc: command.planned_start_at
        ? localDatetimeToUtc(command.planned_start_at, timeZone)
        : null,
      plannedEndAtUtc: command.planned_end_at
        ? localDatetimeToUtc(command.planned_end_at, timeZone)
        : null,
      isMilestone: command.is_milestone ?? false,
      ackRequired: command.ack_required ?? false,
      position: nextTaskPosition(lastPosition),
    });

    await recordMutation(tx, {
      clientMutationId: command.client_mutation_id,
      organizationId: tenant.organizationId,
      memberId: tenant.memberId,
      kind: 'task.create',
      entityId: created.id,
      result: 'applied',
    });

    return created;
  }

  /**
   * ADR-017 §8: se le puede asignar a quien existe en la organización y puede
   * trabajar en el sitio con su propio rol, o es miembro explícito del
   * proyecto (haberlo agregado es una decisión deliberada que pesa más que el
   * sitio).
   */
  private async isAssignable(
    tx: Tx,
    params: { organizationId: string; memberId: string; project: { id: string; siteId: string } },
  ): Promise<boolean> {
    const { organizationId, memberId, project } = params;
    if (
      await this.tenancy.isMemberAssignable(tx, {
        organizationId,
        memberId,
        siteId: project.siteId,
      })
    ) {
      return true;
    }
    return (
      (await this.projectAccess.isExplicitMember(tx, {
        organizationId,
        projectId: project.id,
        memberId,
      })) && (await this.tenancy.isMemberInOrganization(tx, { organizationId, memberId }))
    );
  }
}
