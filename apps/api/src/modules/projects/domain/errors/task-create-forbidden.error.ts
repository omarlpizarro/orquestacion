import { DomainError } from '../../../../shared/errors/domain-error.js';

export class TaskCreateForbiddenError extends DomainError {
  readonly code = 'FORBIDDEN';
  readonly httpStatus = 403;

  constructor() {
    super('No tenés permiso para crear tareas.', { domain_code: 'task_create_forbidden' });
  }
}
