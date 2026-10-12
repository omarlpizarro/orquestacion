import { DomainError } from '../../../../shared/errors/domain-error.js';

/**
 * Su rol edita tareas, pero ve el proyecto solo porque tiene una tarea asignada
 * ("solo asignado", ADR-017 §1): editar exige acceso completo al proyecto.
 */
export class TaskEditProjectAccessError extends DomainError {
  readonly code = 'FORBIDDEN';
  readonly httpStatus = 403;

  constructor() {
    super(
      'Participás de este proyecto solo por las tareas que te asignaron: no podés editar tareas en él.',
      { domain_code: 'task_edit_project_access_forbidden' },
    );
  }
}
