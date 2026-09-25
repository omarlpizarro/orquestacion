import { DomainError } from '../../../../shared/errors/domain-error.js';

export class ParentTaskNotFoundError extends DomainError {
  readonly code = 'NOT_FOUND';
  readonly httpStatus = 404;

  constructor(parentTaskId: string) {
    super('La tarea padre no existe.', {
      domain_code: 'parent_task_not_found',
      details: { parentTaskId },
    });
  }
}
