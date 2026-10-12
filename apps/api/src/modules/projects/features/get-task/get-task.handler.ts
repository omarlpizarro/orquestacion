import { Injectable } from '@nestjs/common';
import type { GetTaskOutput, TaskUpdateOutput } from '@orq/contracts';
import { TransactionService } from '../../../../shared/database/transaction.service.js';
import { getRequestContext } from '../../../../shared/request-context/request-context.js';
import {
  CollaborationService,
  type TaskUpdateDetail,
} from '../../../collaboration/collaboration.module.js';
import { TaskNotFoundError } from '../../domain/errors/task-not-found.error.js';
import { MAX_SUBTASKS, MAX_TASK_UPDATES } from '../../domain/read-limits.js';
import { buildTaskTree } from '../../domain/task-tree.js';
import { findVisibleTask, listTaskDescendants } from '../../infrastructure/task.repository.js';
import { toTaskOutput } from '../../infrastructure/task-output.mapper.js';
import { toTaskTreeOutput } from '../../infrastructure/task-tree-output.mapper.js';
import type { GetTaskQuery } from './get-task.query.js';

function toUpdateOutput(update: TaskUpdateDetail): TaskUpdateOutput {
  return {
    id: update.id,
    task_id: update.taskId,
    kind: update.kind,
    body: update.body,
    metadata: update.metadata,
    created_by_member_id: update.createdByMemberId,
    created_at: update.createdAt,
  };
}

@Injectable()
export class GetTaskHandler {
  constructor(
    private readonly transactions: TransactionService,
    private readonly collaboration: CollaborationService,
  ) {}

  async execute(query: GetTaskQuery): Promise<GetTaskOutput> {
    const { tenant } = getRequestContext();
    if (!tenant) {
      throw new Error('get-task requiere una sesión con organización activa.');
    }
    const { organizationId } = tenant;

    return this.transactions.withTenant(async (tx) => {
      // RLS ya filtra por proyecto y por asignación (ADR-017 §3): lo que quien lee no
      // ve no existe, y "no existe" y "no la ves" dan el mismo 404 (§6).
      const task = await findVisibleTask(tx, { organizationId, taskId: query.id });
      if (!task) throw new TaskNotFoundError(query.id);

      const descendants = await listTaskDescendants(tx, {
        organizationId,
        taskId: task.id,
        limit: MAX_SUBTASKS,
      });
      const subtasksTruncated = descendants.length > MAX_SUBTASKS;
      const subtasks = buildTaskTree(descendants.slice(0, MAX_SUBTASKS), task.id);

      const { updates, truncated: updatesTruncated } = await this.collaboration.listTaskUpdates(
        tx,
        { organizationId, taskId: task.id, limit: MAX_TASK_UPDATES },
      );

      return {
        ...toTaskOutput(task),
        subtasks: toTaskTreeOutput(subtasks) as GetTaskOutput['subtasks'],
        updates: updates.map(toUpdateOutput),
        updates_truncated: updatesTruncated,
        subtasks_truncated: subtasksTruncated,
      };
    });
  }
}
