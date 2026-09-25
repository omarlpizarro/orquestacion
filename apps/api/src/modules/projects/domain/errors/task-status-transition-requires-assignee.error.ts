import { DomainError } from '../../../../shared/errors/domain-error.js';
import type { TaskStatus } from '../task-status.js';

/**
 * CLAUDE.md §7: el nivel `operator` es "sus tareas y su sitio", no
 * cualquier tarea de la organización — a diferencia de `manager`/`director`/
 * `owner`, cuyo permiso no depende de estar asignado. Separado de
 * `TaskStatusTransitionForbiddenError` porque el motivo del rechazo es
 * distinto: ahí el rol nunca puede hacer esa transición; acá sí puede,
 * pero no sobre esta tarea en particular.
 */
export class TaskStatusTransitionRequiresAssigneeError extends DomainError {
  readonly code = 'FORBIDDEN';
  readonly httpStatus = 403;

  constructor(from: TaskStatus, to: TaskStatus) {
    super('Solo la persona asignada a la tarea puede hacer este cambio de estado.', {
      domain_code: 'task_status_transition_requires_assignee',
      details: { from, to },
    });
  }
}
