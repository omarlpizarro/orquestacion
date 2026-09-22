import { Injectable } from '@nestjs/common';
import type { TaskOutput } from '@orq/contracts';
import { findPriorMutation, recordMutation } from '../../../../shared/database/mutation-log.js';
import { TransactionService } from '../../../../shared/database/transaction.service.js';
import { domainEvents } from '../../../../shared/domain-events/domain-events.js';
import { getRequestContext } from '../../../../shared/request-context/request-context.js';
import { TenancyService } from '../../../tenancy/tenancy.module.js';
import { ParentTaskNotFoundError } from '../../domain/errors/parent-task-not-found.error.js';
import { ProjectNotFoundError } from '../../domain/errors/project-not-found.error.js';
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
import type { CreateTaskCommand } from './create-task.command.js';

@Injectable()
export class CreateTaskHandler {
  constructor(
    private readonly transactions: TransactionService,
    private readonly tenancy: TenancyService,
  ) {}

  async execute(command: CreateTaskCommand): Promise<TaskOutput> {
    const { requestId, tenant } = getRequestContext();
    if (!tenant) {
      throw new Error('create-task requiere una sesión con organización activa.');
    }

    const task = await this.transactions.withTenant(async (tx) => {
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
    });

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
}

function toTaskOutput(task: TaskRow): TaskOutput {
  return {
    id: task.id,
    project_id: task.projectId,
    parent_task_id: task.parentTaskId,
    path: task.path,
    title: task.title,
    description: task.description,
    status: task.status as TaskOutput['status'],
    criticality: task.criticality as TaskOutput['criticality'],
    assignee_member_id: task.assigneeMemberId,
    planned_start_at: task.plannedStartAt,
    planned_end_at: task.plannedEndAt,
    is_milestone: task.isMilestone,
    ack_required: task.ackRequired,
    position: task.position,
    version: task.version,
    created_at: task.createdAt,
  };
}
