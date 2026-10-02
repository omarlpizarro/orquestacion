import { DomainError } from '../../../../shared/errors/domain-error.js';

/**
 * Un `manager` solo actúa en los sitios donde tiene fila en
 * `member_site_access` (alcance por sitio, ADR-015/ADR-016). Separado de
 * `TaskCreateForbiddenError` y de `TaskStatusTransitionForbiddenError`: ahí el
 * rol nunca podría hacer la acción; acá sí puede, pero no en este sitio.
 */
export class TaskSiteAccessForbiddenError extends DomainError {
  readonly code = 'FORBIDDEN';
  readonly httpStatus = 403;

  constructor() {
    super('No tenés acceso al sitio de este proyecto.', {
      domain_code: 'task_site_access_forbidden',
    });
  }
}
