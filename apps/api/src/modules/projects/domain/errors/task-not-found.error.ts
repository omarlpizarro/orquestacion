import { DomainError } from '../../../../shared/errors/domain-error.js';

export class TaskNotFoundError extends DomainError {
  readonly code = 'NOT_FOUND';
  readonly httpStatus = 404;

  constructor(taskId: string) {
    super('La tarea no existe.', { domain_code: 'task_not_found', details: { taskId } });
  }
}
