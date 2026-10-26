import { DomainError } from '../../../../shared/errors/domain-error.js';

/** El rol del miembro no tiene la capacidad `directory:read` (dato corrupto: los cuatro roles la tienen). */
export class DirectoryForbiddenError extends DomainError {
  readonly code = 'FORBIDDEN';
  readonly httpStatus = 403;

  constructor() {
    super('No tenés permiso para ver los nombres de los miembros.', {
      domain_code: 'directory_forbidden',
    });
  }
}
