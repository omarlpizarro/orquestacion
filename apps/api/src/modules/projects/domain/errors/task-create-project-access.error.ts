import { DomainError } from '../../../../shared/errors/domain-error.js';

/**
 * Ve el proyecto pero solo porque tiene una tarea asignada en él ("solo
 * asignado", ADR-017): crear tareas exige acceso completo. Distinto de
 * `TaskCreateForbiddenError` (el rol nunca podría crear tareas) y del 404 de
 * quien directamente no ve el proyecto.
 */
export class TaskCreateProjectAccessError extends DomainError {
  readonly code = 'FORBIDDEN';
  readonly httpStatus = 403;

  constructor() {
    super(
      'Participás de este proyecto solo por las tareas que te asignaron: no podés crear tareas en él.',
      { domain_code: 'task_create_project_access_forbidden' },
    );
  }
}
