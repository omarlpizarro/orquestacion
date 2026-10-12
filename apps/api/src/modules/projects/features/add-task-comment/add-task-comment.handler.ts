import { Injectable } from '@nestjs/common';
import type { TaskUpdateOutput } from '@orq/contracts';
import type { Tx } from '@orq/db';
import { claimMutation } from '../../../../shared/database/mutation-log.js';
import {
  hasPostgresErrorCode,
  postgresErrorConstraint,
  UNIQUE_VIOLATION,
} from '../../../../shared/database/postgres-errors.js';
import { TransactionService } from '../../../../shared/database/transaction.service.js';
import { domainEvents } from '../../../../shared/domain-events/domain-events.js';
import { MutationIdReusedError } from '../../../../shared/errors/mutation-id-reused.error.js';
import {
  getRequestContext,
  type TenantIdentity,
} from '../../../../shared/request-context/request-context.js';
import {
  CollaborationService,
  type TaskUpdateDetail,
} from '../../../collaboration/collaboration.module.js';
import { TaskCommentIdTakenError } from '../../domain/errors/task-comment-id-taken.error.js';
import { TaskNotFoundError } from '../../domain/errors/task-not-found.error.js';
import { findVisibleTask } from '../../infrastructure/task.repository.js';
import type { AddTaskCommentCommand } from './add-task-comment.command.js';

const TASK_UPDATE_PKEY = 'task_update_pkey';

interface CommentOutcome {
  comment: TaskUpdateDetail;
  projectId: string | null;
  /** `false` cuando es el reintento de una mutación ya aplicada. */
  created: boolean;
}

@Injectable()
export class AddTaskCommentHandler {
  constructor(
    private readonly transactions: TransactionService,
    private readonly collaboration: CollaborationService,
  ) {}

  async execute(command: AddTaskCommentCommand): Promise<TaskUpdateOutput> {
    const { requestId, tenant } = getRequestContext();
    if (!tenant) {
      throw new Error('add-task-comment requiere una sesión con organización activa.');
    }

    const { comment, projectId, created } = await this.applyOrExplain(command, tenant);

    // Después del commit, nunca desde dentro del callback (ADR-009).
    if (created && projectId) {
      domainEvents.emitEvent('task.commented', {
        taskId: comment.taskId,
        commentId: comment.id,
        organizationId: tenant.organizationId,
        projectId,
        authorMemberId: comment.createdByMemberId,
        requestId,
      });
    }

    return {
      id: comment.id,
      task_id: comment.taskId,
      kind: comment.kind,
      body: comment.body,
      metadata: comment.metadata,
      created_by_member_id: comment.createdByMemberId,
      created_at: comment.createdAt,
    };
  }

  /**
   * Dos pedidos con el mismo `client_mutation_id` a la vez se serializan en
   * `claimMutation` (ADR-007). Lo único que puede chocar por unicidad es el `id`
   * de la novedad reusado con una mutación nueva: se informa como error de dominio.
   */
  private async applyOrExplain(
    command: AddTaskCommentCommand,
    tenant: TenantIdentity,
  ): Promise<CommentOutcome> {
    try {
      return await this.transactions.withTenant((tx) => this.applyMutation(command, tenant, tx));
    } catch (error) {
      if (
        hasPostgresErrorCode(error, UNIQUE_VIOLATION) &&
        postgresErrorConstraint(error) === TASK_UPDATE_PKEY
      ) {
        throw new TaskCommentIdTakenError(command.id);
      }
      throw error;
    }
  }

  private async applyMutation(
    command: AddTaskCommentCommand,
    tenant: TenantIdentity,
    tx: Tx,
  ): Promise<CommentOutcome> {
    const { organizationId, memberId } = tenant;

    // Primera sentencia de la transacción (ADR-007): la entidad de la mutación es la
    // novedad, cuyo id viene en el pedido.
    const claim = await claimMutation(tx, {
      clientMutationId: command.client_mutation_id,
      organizationId,
      memberId,
      kind: 'task.comment',
      entityId: command.id,
    });
    if (!claim.claimed) {
      const existing = await this.collaboration.findTaskUpdate(tx, {
        organizationId,
        id: command.id,
      });
      // Si ya no la ve (le sacaron el acceso después), no hay respuesta que reconstruir.
      if (!existing) throw new TaskNotFoundError(command.task_id);
      // Mismo id de mutación y de novedad, pero para otra tarea: no es un reintento.
      if (existing.taskId.toLowerCase() !== command.task_id.toLowerCase()) {
        throw new MutationIdReusedError();
      }
      return { comment: existing, projectId: null, created: false };
    }

    // 404 si la tarea no existe o si quien comenta no la ve (ADR-017 §6). Comentan
    // quienes la ven: acceso completo al proyecto, o "solo asignado" en sus propias
    // tareas. La policy de INSERT de `task_update` lo impone también en la base.
    const task = await findVisibleTask(tx, { organizationId, taskId: command.task_id });
    if (!task) throw new TaskNotFoundError(command.task_id);

    const comment = await this.collaboration.createTaskUpdate(tx, {
      id: command.id,
      organizationId,
      createdByMemberId: memberId,
      taskId: task.id,
      kind: 'comment',
      body: command.body,
    });
    return { comment, projectId: task.projectId, created: true };
  }
}
