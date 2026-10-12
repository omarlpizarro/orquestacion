import { DomainError } from '../../../../shared/errors/domain-error.js';

/**
 * Una tarea `cancelled` está congelada: cancelar no tiene vuelta atrás (ADR-012), así
 * que tampoco se edita. Las `done` sí se editan, porque se pueden reabrir.
 */
export class TaskEditCancelledError extends DomainError {
  readonly code = 'UNPROCESSABLE_CONTENT';
  readonly httpStatus = 422;

  constructor() {
    super('Una tarea cancelada no se puede editar: cancelar no tiene vuelta atrás.', {
      domain_code: 'task_edit_cancelled',
    });
  }
}
