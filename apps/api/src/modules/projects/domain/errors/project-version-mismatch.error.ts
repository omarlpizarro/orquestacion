import { DomainError } from '../../../../shared/errors/domain-error.js';

/**
 * Concurrencia optimista (docs/data-model.md, "Concurrencia"): cubre tanto un
 * `expected_version` viejo como perder la carrera entre el `SELECT` y el
 * `UPDATE ... WHERE version = $esperado`.
 */
export class ProjectVersionMismatchError extends DomainError {
  readonly code = 'CONFLICT';
  readonly httpStatus = 409;

  constructor(projectId: string, expectedVersion: number) {
    super('El proyecto cambió mientras tanto; volvé a cargarlo antes de reintentar.', {
      domain_code: 'project_version_mismatch',
      details: { projectId, expectedVersion },
    });
  }
}
