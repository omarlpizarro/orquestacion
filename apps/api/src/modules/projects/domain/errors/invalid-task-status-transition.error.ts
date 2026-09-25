import { DomainError } from '../../../../shared/errors/domain-error.js';
import type { TaskStatus } from '../task-status.js';

export class InvalidTaskStatusTransitionError extends DomainError {
  readonly code = 'UNPROCESSABLE_CONTENT';
  readonly httpStatus = 422;

  constructor(from: TaskStatus, to: TaskStatus) {
    super(`No se puede pasar una tarea de "${from}" a "${to}".`, {
      domain_code: 'invalid_task_status_transition',
      details: { from, to },
    });
  }
}
