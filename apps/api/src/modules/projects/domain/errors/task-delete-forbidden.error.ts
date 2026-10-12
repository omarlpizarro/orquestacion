import { DomainError } from '../../../../shared/errors/domain-error.js';

/**
 * Ve la tarea pero su rol no borra: borrar tareas es de `owner`, `director` y `manager`
 * (capacidad `task:delete`). Distinto del 404 de quien directamente no la ve (ADR-017 §6).
 */
export class TaskDeleteForbiddenError extends DomainError {
  readonly code = 'FORBIDDEN';
  readonly httpStatus = 403;

  constructor() {
    super('No tenés permiso para borrar tareas.', { domain_code: 'task_delete_forbidden' });
  }
}
