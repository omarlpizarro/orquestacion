import { DomainError } from '../../../../shared/errors/domain-error.js';

/**
 * Ve la tarea pero su rol no edita: el título, la descripción, la criticidad y las
 * fechas son de `owner`, `director` y `manager` (capacidad `task:update`). El
 * operario cambia el estado y comenta, también en sus propias tareas. Distinto del
 * 404 de quien directamente no la ve (ADR-017 §6).
 */
export class TaskEditForbiddenError extends DomainError {
  readonly code = 'FORBIDDEN';
  readonly httpStatus = 403;

  constructor() {
    super('No tenés permiso para editar tareas.', { domain_code: 'task_edit_forbidden' });
  }
}
