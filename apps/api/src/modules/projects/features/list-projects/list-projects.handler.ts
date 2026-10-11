import { Injectable } from '@nestjs/common';
import type { ListProjectsOutput } from '@orq/contracts';
import { TransactionService } from '../../../../shared/database/transaction.service.js';
import { getRequestContext } from '../../../../shared/request-context/request-context.js';
import { listProjects } from '../../infrastructure/project.repository.js';
import { toProjectOutput } from '../../infrastructure/project-output.mapper.js';
import type { ListProjectsQuery } from './list-projects.query.js';

const DEFAULT_LIMIT = 100;

@Injectable()
export class ListProjectsHandler {
  constructor(private readonly transactions: TransactionService) {}

  async execute(query: ListProjectsQuery): Promise<ListProjectsOutput> {
    const { tenant } = getRequestContext();
    if (!tenant) {
      throw new Error('list-projects requiere una sesión con organización activa.');
    }

    // Sin filtro de acceso en el código: lo que no se ve, la base no lo devuelve.
    const projects = await this.transactions.withTenant((tx) =>
      listProjects(tx, {
        organizationId: tenant.organizationId,
        limit: query.limit ?? DEFAULT_LIMIT,
      }),
    );
    return { projects: projects.map(toProjectOutput) };
  }
}
