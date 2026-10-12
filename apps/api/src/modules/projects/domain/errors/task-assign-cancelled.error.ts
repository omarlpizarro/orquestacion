import { DomainError } from '../../../../shared/errors/domain-error.js';

/**
 * Una tarea `cancelled` está congelada: cancelar no tiene vuelta atrás (ADR-012), así
 * que tampoco se reasigna. Las `done` sí, porque se pueden reabrir.
 */
export class TaskAssignCancelledError extends DomainError {
  readonly code = 'UNPROCESSABLE_CONTENT';
  readonly httpStatus = 422;

  constructor() {
    super('Una tarea cancelada no se puede reasignar: cancelar no tiene vuelta atrás.', {
      domain_code: 'task_assign_cancelled',
    });
  }
}
