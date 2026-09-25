import { DomainError } from '../../../../shared/errors/domain-error.js';

/**
 * Concurrencia optimista (docs/data-model.md, convención "Concurrencia"):
 * `version` lo avanza el trigger, la aplicación solo lo compara. Cubre dos
 * casos con el mismo error — el request llegó con un `expected_version` ya
 * viejo, o alguien más ganó la carrera entre el `SELECT` de este handler y
 * su `UPDATE ... WHERE version = $esperado` — porque para quien pidió el
 * cambio son la misma situación: "lo que tenías no es lo último, traé de
 * nuevo la tarea y reintentá".
 */
export class TaskVersionMismatchError extends DomainError {
  readonly code = 'CONFLICT';
  readonly httpStatus = 409;

  constructor(taskId: string, expectedVersion: number) {
    super('La tarea cambió mientras tanto; volvé a cargarla antes de reintentar.', {
      domain_code: 'task_version_mismatch',
      details: { taskId, expectedVersion },
    });
  }
}
