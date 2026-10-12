import { DomainError } from '../../../../shared/errors/domain-error.js';

/**
 * La fecha de fin planificada queda antes que la de inicio. La base lo impide con
 * `task_dates_coherent_check`; acá se detecta antes para devolver un motivo que el
 * usuario pueda leer en vez de un error de restricción.
 */
export class TaskDatesIncoherentError extends DomainError {
  readonly code = 'UNPROCESSABLE_CONTENT';
  readonly httpStatus = 422;

  constructor() {
    super('La fecha de fin no puede ser anterior a la de inicio.', {
      domain_code: 'task_dates_incoherent',
    });
  }
}
