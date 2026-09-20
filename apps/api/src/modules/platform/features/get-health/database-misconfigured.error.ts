import { DomainError } from '../../../../shared/errors/domain-error.js';

export class DatabaseMisconfiguredError extends DomainError {
  readonly code = 'DATABASE_MISCONFIGURED';
  readonly httpStatus = 503;

  constructor(connectedAs: string | undefined) {
    super('La base de datos está mal configurada.', { connectedAs });
  }
}
