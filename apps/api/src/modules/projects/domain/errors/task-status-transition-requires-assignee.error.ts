import { DomainError } from '../../../../shared/errors/domain-error.js';
import type { TaskStatus } from '../task-status.js';

/**
 * CLAUDE.md §7: el nivel `operator` es "sus tareas y su sitio", no
 * cualquier tarea de la organización — a diferencia de `manager`/`director`/
 * `owner`, cuyo permiso no depende de estar asignado. Separado de
 * `TaskStatusTransitionForbiddenError` porque el motivo del rechazo es
 * distinto: ahí el rol nunca puede hacer esa transición; acá sí puede,
 * pero no sobre esta tarea en particular.
 *
 * El mensaje cubre los dos casos en que se rechaza: tarea asignada a otra
 * persona, o tarea sin asignar donde lo único permitido es bloquearla.
 */
export class TaskStatusTransitionRequiresAssigneeError extends DomainError {
  readonly code = 'FORBIDDEN';
  readonly httpStatus = 403;

  constructor(from: TaskStatus, to: TaskStatus) {
    super(
      'Solo la persona asignada puede cambiar el estado de esta tarea. ' +
        'Si la tarea no tiene a nadie asignado y es de tu sitio, solo podés marcarla como bloqueada.',
      {
        domain_code: 'task_status_transition_requires_assignee',
        details: { from, to },
      },
    );
  }
}
