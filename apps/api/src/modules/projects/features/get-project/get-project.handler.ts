import { Injectable } from '@nestjs/common';
import type { ProjectOutput } from '@orq/contracts';
import { TransactionService } from '../../../../shared/database/transaction.service.js';
import { getRequestContext } from '../../../../shared/request-context/request-context.js';
import { ProjectNotFoundError } from '../../domain/errors/project-not-found.error.js';
import { findProjectById } from '../../infrastructure/project.repository.js';
import { toProjectOutput } from '../../infrastructure/project-output.mapper.js';
import type { GetProjectQuery } from './get-project.query.js';

@Injectable()
export class GetProjectHandler {
  constructor(private readonly transactions: TransactionService) {}

  async execute(query: GetProjectQuery): Promise<ProjectOutput> {
    const { tenant } = getRequestContext();
    if (!tenant) {
      throw new Error('get-project requiere una sesión con organización activa.');
    }

    // RLS ya filtra por proyecto (ADR-017 §3): lo que no se ve no existe, y
    // "no existe" y "no lo ves" dan el mismo 404 (§6).
    const project = await this.transactions.withTenant((tx) =>
      findProjectById(tx, { organizationId: tenant.organizationId, projectId: query.project_id }),
    );
    if (!project) throw new ProjectNotFoundError(query.project_id);

    return toProjectOutput(project);
  }
}
