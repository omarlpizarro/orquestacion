import { DomainError } from '../../../../shared/errors/domain-error.js';

/** El rol del miembro no tiene la capacidad `notification:read` (dato corrupto: los cuatro roles la tienen). */
export class NotificationForbiddenError extends DomainError {
  readonly code = 'FORBIDDEN';
  readonly httpStatus = 403;

  constructor() {
    super('No tenés permiso para ver avisos.', { domain_code: 'notification_forbidden' });
  }
}
