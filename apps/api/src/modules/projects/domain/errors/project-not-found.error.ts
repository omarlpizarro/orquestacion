import { DomainError } from '../../../../shared/errors/domain-error.js';

export class ProjectNotFoundError extends DomainError {
  readonly code = 'NOT_FOUND';
  readonly httpStatus = 404;

  constructor(projectId: string) {
    super('El proyecto no existe.', { domain_code: 'project_not_found', details: { projectId } });
  }
}
