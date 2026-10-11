import { DomainError } from '../../../../shared/errors/domain-error.js';

/**
 * ADR-017 §8: agregan y quitan miembros el creador, `owner` y `director`, con
 * acceso completo.
 */
export class ProjectMembersManageForbiddenError extends DomainError {
  readonly code = 'FORBIDDEN';
  readonly httpStatus = 403;

  constructor() {
    super('No tenés permiso para manejar los miembros de este proyecto.', {
      domain_code: 'project_members_manage_forbidden',
    });
  }
}
