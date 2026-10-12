import { Injectable } from '@nestjs/common';
import type { ListProjectTasksOutput } from '@orq/contracts';
import { TransactionService } from '../../../../shared/database/transaction.service.js';
import { getRequestContext } from '../../../../shared/request-context/request-context.js';
import { ProjectNotFoundError } from '../../domain/errors/project-not-found.error.js';
import { MAX_PROJECT_TASKS } from '../../domain/read-limits.js';
import { buildTaskTree } from '../../domain/task-tree.js';
import { findProjectById } from '../../infrastructure/project.repository.js';
import { listProjectTasks } from '../../infrastructure/task.repository.js';
import { toTaskTreeOutput } from '../../infrastructure/task-tree-output.mapper.js';
import type { ListProjectTasksQuery } from './list-project-tasks.query.js';

@Injectable()
export class ListProjectTasksHandler {
  constructor(private readonly transactions: TransactionService) {}

  async execute(query: ListProjectTasksQuery): Promise<ListProjectTasksOutput> {
    const { tenant } = getRequestContext();
    if (!tenant) {
      throw new Error('list-project-tasks requiere una sesión con organización activa.');
    }
    const { organizationId } = tenant;

    return this.transactions.withTenant(async (tx) => {
      // 404 si no existe o si no lo ve (ADR-017 §6). El nivel de acceso decide qué
      // devuelve la base: con "solo asignado", RLS deja únicamente las tareas asignadas.
      const project = await findProjectById(tx, { organizationId, projectId: query.project_id });
      if (!project) throw new ProjectNotFoundError(query.project_id);

      const rows = await listProjectTasks(tx, {
        organizationId,
        projectId: project.id,
        limit: MAX_PROJECT_TASKS,
      });

      return {
        access_level: project.fullAccess ? 'full' : 'assigned',
        tasks: toTaskTreeOutput(buildTaskTree(rows.slice(0, MAX_PROJECT_TASKS))),
        truncated: rows.length > MAX_PROJECT_TASKS,
      };
    });
  }
}
