import { DomainError } from '../../../../shared/errors/domain-error.js';

/**
 * Un solo error para "no es de la organización" y "no trabaja en el sitio del
 * proyecto": distinguirlos le diría a quien asigna si un id ajeno corresponde
 * a un miembro de otra organización.
 */
export class AssigneeNotAssignableError extends DomainError {
  readonly code = 'UNPROCESSABLE_CONTENT';
  readonly httpStatus = 422;

  constructor(assigneeMemberId: string) {
    super('No se puede asignar la tarea a esa persona: no trabaja en el sitio de este proyecto.', {
      domain_code: 'assignee_not_assignable',
      details: { assigneeMemberId },
    });
  }
}
