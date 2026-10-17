import { DomainError } from '../../../../shared/errors/domain-error.js';

export class InvalidNotificationCursorError extends DomainError {
  readonly code = 'BAD_REQUEST';
  readonly httpStatus = 400;

  constructor() {
    super('El cursor no es válido. Pedí la lista desde el principio.', {
      domain_code: 'invalid_notification_cursor',
    });
  }
}
