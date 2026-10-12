import { DomainError } from '../../../../shared/errors/domain-error.js';

/**
 * Su rol asigna, pero ve el proyecto solo porque tiene una tarea asignada ("solo
 * asignado", ADR-017 §1): asignar exige acceso completo al proyecto.
 */
export class TaskAssignProjectAccessError extends DomainError {
  readonly code = 'FORBIDDEN';
  readonly httpStatus = 403;

  constructor() {
    super(
      'Participás de este proyecto solo por las tareas que te asignaron: no podés asignar tareas en él.',
      { domain_code: 'task_assign_project_access_forbidden' },
    );
  }
}
