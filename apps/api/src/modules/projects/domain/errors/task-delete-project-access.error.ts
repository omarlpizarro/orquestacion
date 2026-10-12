import { DomainError } from '../../../../shared/errors/domain-error.js';

/**
 * Su rol borra tareas, pero ve el proyecto solo porque tiene una tarea asignada ("solo
 * asignado", ADR-017 §1): borrar exige acceso completo al proyecto.
 */
export class TaskDeleteProjectAccessError extends DomainError {
  readonly code = 'FORBIDDEN';
  readonly httpStatus = 403;

  constructor() {
    super(
      'Participás de este proyecto solo por las tareas que te asignaron: no podés borrar tareas en él.',
      { domain_code: 'task_delete_project_access_forbidden' },
    );
  }
}
