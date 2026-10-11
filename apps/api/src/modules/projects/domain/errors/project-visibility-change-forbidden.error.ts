import { DomainError } from '../../../../shared/errors/domain-error.js';

/**
 * ADR-017 §8: la cambian el creador, `owner` y `director`, y solo con acceso
 * completo (ver el proyecto solo por una tarea asignada no alcanza).
 */
export class ProjectVisibilityChangeForbiddenError extends DomainError {
  readonly code = 'FORBIDDEN';
  readonly httpStatus = 403;

  constructor() {
    super('No tenés permiso para cambiar la visibilidad de este proyecto.', {
      domain_code: 'project_visibility_change_forbidden',
    });
  }
}
