import { DomainError } from '../../../../shared/errors/domain-error.js';

/**
 * Crear proyectos es del nivel 1 (`owner` y `director`, RF-C1).
 */
export class ProjectCreateForbiddenError extends DomainError {
  readonly code = 'FORBIDDEN';
  readonly httpStatus = 403;

  constructor() {
    super('No tenés permiso para crear proyectos.', { domain_code: 'project_create_forbidden' });
  }
}
