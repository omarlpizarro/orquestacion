import { DomainError } from '../../../../shared/errors/domain-error.js';

/**
 * Se quita a alguien que no figura como miembro explícito (un acceso por
 * sitio o por asignación no se quita acá).
 */
export class ProjectMemberNotFoundError extends DomainError {
  readonly code = 'NOT_FOUND';
  readonly httpStatus = 404;

  constructor() {
    super('Esa persona no es miembro de este proyecto.', {
      domain_code: 'project_member_not_found',
    });
  }
}
