import { DomainError } from '../../../../shared/errors/domain-error.js';

/**
 * Ve la tarea pero su rol no asigna: asignar y reasignar es de `owner`, `director` y
 * `manager` (capacidad `task:assign`). El operario cambia el estado y comenta.
 * Distinto del 404 de quien directamente no la ve (ADR-017 §6).
 */
export class TaskAssignForbiddenError extends DomainError {
  readonly code = 'FORBIDDEN';
  readonly httpStatus = 403;

  constructor() {
    super('No tenés permiso para asignar tareas.', { domain_code: 'task_assign_forbidden' });
  }
}
