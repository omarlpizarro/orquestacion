import { DomainError } from '../../../../shared/errors/domain-error.js';

/**
 * El aviso no existe **o no es de quien lo pide**: se responde igual, para no revelar que el id
 * es de otra persona. Las policies de la base ya hacen invisible el ajeno (ADR-019).
 */
export class NotificationNotFoundError extends DomainError {
  readonly code = 'NOT_FOUND';
  readonly httpStatus = 404;

  constructor(notificationId: string) {
    super('El aviso no existe.', {
      domain_code: 'notification_not_found',
      details: { notificationId },
    });
  }
}
