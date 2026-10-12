import { DomainError } from '../../../../shared/errors/domain-error.js';

/**
 * Sin detalles a propósito: distinguir "no existe" de "es de otra
 * organización" le diría a quien agrega si un id ajeno corresponde a un
 * miembro de otro tenant.
 */
export class ProjectMemberNotInOrganizationError extends DomainError {
  readonly code = 'UNPROCESSABLE_CONTENT';
  readonly httpStatus = 422;

  constructor() {
    super('Esa persona no es miembro de la organización.', {
      domain_code: 'project_member_not_in_organization',
    });
  }
}
