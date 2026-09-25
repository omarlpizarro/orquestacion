import { DomainError } from '../../../../shared/errors/domain-error.js';
import type { OrgRole, TaskStatus } from '../task-status.js';

export class TaskStatusTransitionForbiddenError extends DomainError {
  readonly code = 'FORBIDDEN';
  readonly httpStatus = 403;

  constructor(from: TaskStatus, to: TaskStatus, role: OrgRole) {
    super(`Tu rol no tiene permiso para pasar una tarea de "${from}" a "${to}".`, {
      domain_code: 'task_status_transition_forbidden',
      details: { from, to, role },
    });
  }
}
