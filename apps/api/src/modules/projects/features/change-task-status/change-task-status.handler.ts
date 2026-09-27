import { Injectable } from '@nestjs/common';
import { newId, type TaskOutput } from '@orq/contracts';
import type { Tx } from '@orq/db';
import { findPriorMutation, recordMutation } from '../../../../shared/database/mutation-log.js';
import {
  hasPostgresErrorCode,
  UNIQUE_VIOLATION,
} from '../../../../shared/database/postgres-errors.js';
import { TransactionService } from '../../../../shared/database/transaction.service.js';
import { domainEvents } from '../../../../shared/domain-events/domain-events.js';
import type { TenantIdentity } from '../../../../shared/request-context/request-context.js';
import { getRequestContext } from '../../../../shared/request-context/request-context.js';
import { CollaborationService } from '../../../collaboration/collaboration.module.js';
import { TaskNotFoundError } from '../../domain/errors/task-not-found.error.js';
import { TaskVersionMismatchError } from '../../domain/errors/task-version-mismatch.error.js';
import {
  parseSingleOrgRole,
  resolveTaskStatusTransition,
  type TaskStatus,
} from '../../domain/task-status-transitions.js';
import {
  findTaskById,
  type TaskRow,
  updateTaskStatus,
} from '../../infrastructure/task.repository.js';
import { toTaskOutput } from '../../infrastructure/task-output.mapper.js';
import type { ChangeTaskStatusCommand } from './change-task-status.command.js';

@Injectable()
export class ChangeTaskStatusHandler {
  constructor(
    private readonly transactions: TransactionService,
    private readonly collaboration: CollaborationService,
  ) {}

  async execute(command: ChangeTaskStatusCommand): Promise<TaskOutput> {
    const { requestId, tenant } = getRequestContext();
    if (!tenant) {
      throw new Error('change-task-status requiere una sesión con organización activa.');
    }

    const { task, fromStatus } = await this.applyOrReplayMutation(command, tenant);

    // Después del commit, nunca desde dentro del callback: si la
    // transacción hiciera rollback, no hay que avisarle a nadie de algo
    // que no pasó (ADR-009). En un reintento idempotente, fromStatus/toStatus
    // son los mismos que ya se emitieron la primera vez: no hay evento nuevo
    // que emitir por un efecto que no se repitió (ver applyOrReplayMutation).
    if (fromStatus !== null) {
      domainEvents.emitEvent('task.status_changed', {
        taskId: task.id,
        organizationId: tenant.organizationId,
        fromStatus,
        toStatus: task.status,
        requestId,
      });
    }

    return toTaskOutput(task);
  }

  /**
   * Mismo criterio que `CreateTaskHandler` (PR 1): dos agujeros de
   * idempotencia si esto fuera una sola pasada. `fromStatus: null` en el
   * resultado marca un reintento (la mutación ya se había aplicado antes),
   * para que `execute` no vuelva a emitir el evento de dominio.
   */
  private async applyOrReplayMutation(
    command: ChangeTaskStatusCommand,
    tenant: TenantIdentity,
  ): Promise<{ task: TaskRow; fromStatus: string | null }> {
    try {
      return await this.transactions.withTenant((tx) => this.applyMutation(command, tenant, tx));
    } catch (error) {
      if (!hasPostgresErrorCode(error, UNIQUE_VIOLATION)) throw error;

      const replayed = await this.transactions.withTenant(async (tx) => {
        const prior = await findPriorMutation(tx, command.client_mutation_id);
        if (!prior?.entityId) return null;
        return findTaskById(tx, { organizationId: tenant.organizationId, taskId: prior.entityId });
      });
      if (!replayed) throw error;
      return { task: replayed, fromStatus: null };
    }
  }

  private async applyMutation(
    command: ChangeTaskStatusCommand,
    tenant: TenantIdentity,
    tx: Tx,
  ): Promise<{ task: TaskRow; fromStatus: string | null }> {
    const prior = await findPriorMutation(tx, command.client_mutation_id);
    if (prior?.result === 'applied' && prior.entityId) {
      const existing = await findTaskById(tx, {
        organizationId: tenant.organizationId,
        taskId: prior.entityId,
      });
      if (existing) return { task: existing, fromStatus: null };
    }

    const current = await findTaskById(tx, {
      organizationId: tenant.organizationId,
      taskId: command.id,
    });
    if (!current) throw new TaskNotFoundError(command.id);
    if (current.version !== command.expected_version) {
      throw new TaskVersionMismatchError(command.id, command.expected_version);
    }

    const transition = resolveTaskStatusTransition({
      from: current.status as TaskStatus,
      to: command.to_status,
      role: parseSingleOrgRole(tenant.role),
      isAssignee: current.assigneeMemberId === tenant.memberId,
      reason: command.reason,
    });

    const updated = await updateTaskStatus(tx, {
      organizationId: tenant.organizationId,
      taskId: command.id,
      expectedVersion: command.expected_version,
      toStatus: command.to_status,
      setsActualEndAt: transition.setsActualEndAt,
      clearsActualEndAt: transition.clearsActualEndAt,
    });
    // El `findTaskById` de arriba ya confirmó que la tarea existe: si acá
    // vuelve vacío es porque alguien más ganó la carrera entre esa lectura
    // y este `UPDATE ... WHERE version = $esperado`, nunca porque no exista.
    if (!updated) throw new TaskVersionMismatchError(command.id, command.expected_version);

    await this.collaboration.createTaskUpdate(tx, {
      id: newId(),
      organizationId: tenant.organizationId,
      createdByMemberId: tenant.memberId,
      taskId: command.id,
      kind: transition.requiresReason ?? 'status_change',
      body: transition.requiresReason ? (command.reason as string) : null,
      metadata: { from: current.status, to: command.to_status },
    });

    await recordMutation(tx, {
      clientMutationId: command.client_mutation_id,
      organizationId: tenant.organizationId,
      memberId: tenant.memberId,
      kind: 'task.change-status',
      entityId: updated.id,
      result: 'applied',
    });

    return { task: updated, fromStatus: current.status };
  }
}
