import { Injectable } from '@nestjs/common';
import { newId, type TaskOutput } from '@orq/contracts';
import type { Tx } from '@orq/db';
import { parseSingleOrgRole } from '../../../../shared/auth/org-role.js';
import { claimMutation } from '../../../../shared/database/mutation-log.js';
import { TransactionService } from '../../../../shared/database/transaction.service.js';
import { domainEvents } from '../../../../shared/domain-events/domain-events.js';
import type { TenantIdentity } from '../../../../shared/request-context/request-context.js';
import { getRequestContext } from '../../../../shared/request-context/request-context.js';
import {
  CollaborationService,
  type TaskUpdateKind,
} from '../../../collaboration/collaboration.module.js';
import { TaskNotFoundError } from '../../domain/errors/task-not-found.error.js';
import { TaskVersionMismatchError } from '../../domain/errors/task-version-mismatch.error.js';
import {
  type ReasonKind,
  resolveTaskStatusTransition,
  type TaskStatus,
} from '../../domain/task-status-transitions.js';
import {
  findTaskById,
  type TaskRow,
  updateTaskStatus,
} from '../../infrastructure/task.repository.js';
import { toTaskOutput } from '../../infrastructure/task-output.mapper.js';
import { ProjectAccessService } from '../../project-access.service.js';
import type { ChangeTaskStatusCommand } from './change-task-status.command.js';

/**
 * `ReasonKind` (dominio de `projects`) y `TaskUpdateKind` (`collaboration`)
 * son dos tipos distintos que hoy comparten los mismos nombres de valor.
 * Un `Record` explícito, en vez de `transition.requiresReason ?? 'status_change'`
 * pasado directo como `kind`, hace que agregar un `ReasonKind` nuevo sin
 * agregarlo acá (o sin que ese valor exista también en `TaskUpdateKind`)
 * falle al compilar — no en runtime contra `task_update_kind_check`.
 */
const REASON_KIND_TO_TASK_UPDATE_KIND: Record<ReasonKind, TaskUpdateKind> = {
  block_report: 'block_report',
  reopen: 'reopen',
};

@Injectable()
export class ChangeTaskStatusHandler {
  constructor(
    private readonly transactions: TransactionService,
    private readonly collaboration: CollaborationService,
    private readonly projectAccess: ProjectAccessService,
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
   * `fromStatus: null` en el resultado marca un reintento (la mutación ya se
   * había aplicado antes), para que `execute` no vuelva a emitir el evento de
   * dominio. Dos pedidos simultáneos con el mismo `client_mutation_id` se
   * serializan en `claimMutation` (ADR-007): el segundo espera, ve la mutación
   * confirmada y devuelve la respuesta del primero.
   */
  private applyOrReplayMutation(
    command: ChangeTaskStatusCommand,
    tenant: TenantIdentity,
  ): Promise<{ task: TaskRow; fromStatus: string | null }> {
    return this.transactions.withTenant((tx) => this.applyMutation(command, tenant, tx));
  }

  private async applyMutation(
    command: ChangeTaskStatusCommand,
    tenant: TenantIdentity,
    tx: Tx,
  ): Promise<{ task: TaskRow; fromStatus: string | null }> {
    // Primera sentencia de la transacción: se reserva la mutación antes de leer
    // la tarea (ADR-007).
    const claim = await claimMutation(tx, {
      clientMutationId: command.client_mutation_id,
      organizationId: tenant.organizationId,
      memberId: tenant.memberId,
      kind: 'task.change-status',
      entityId: command.id,
    });
    if (!claim.claimed) {
      const existing = await findTaskById(tx, {
        organizationId: tenant.organizationId,
        taskId: claim.prior.entityId ?? command.id,
      });
      // Si ya no la ve (le sacaron el acceso después), no hay respuesta que reconstruir.
      if (!existing) throw new TaskNotFoundError(command.id);
      return { task: existing, fromStatus: null };
    }

    // Orden fijo de ADR-017 §6: 404 → 403 → 409. RLS devuelve "no existe" para
    // una tarea que quien pide no ve (proyecto reservado ajeno, tarea de otro
    // en un proyecto donde solo está asignado), igual que si no existiera.
    const current = await findTaskById(tx, {
      organizationId: tenant.organizationId,
      taskId: command.id,
    });
    if (!current) throw new TaskNotFoundError(command.id);
    const role = parseSingleOrgRole(tenant.role);
    const hasFullProjectAccess = await this.projectAccess.hasFullAccess(tx, {
      projectId: current.projectId,
    });

    const transition = resolveTaskStatusTransition({
      from: current.status as TaskStatus,
      to: command.to_status,
      role,
      isAssignee: current.assigneeMemberId === tenant.memberId,
      isUnassigned: current.assigneeMemberId === null,
      hasFullProjectAccess,
      reason: command.reason,
    });

    // Después de autorizar, a propósito: un 409 le diría a quien no puede
    // tocar la tarea que existe y que cambió desde que la vio.
    if (current.version !== command.expected_version) {
      throw new TaskVersionMismatchError(command.id, command.expected_version);
    }

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
      kind: transition.requiresReason
        ? REASON_KIND_TO_TASK_UPDATE_KIND[transition.requiresReason]
        : 'status_change',
      body: transition.reason,
      metadata: { from: current.status, to: command.to_status },
    });

    return { task: updated, fromStatus: current.status };
  }
}
