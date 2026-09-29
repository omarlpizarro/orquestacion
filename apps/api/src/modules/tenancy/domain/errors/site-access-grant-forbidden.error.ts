import { DomainError } from '../../../../shared/errors/domain-error.js';

export class SiteAccessGrantForbiddenError extends DomainError {
  readonly code = 'FORBIDDEN';
  readonly httpStatus = 403;

  constructor() {
    super('Solo el propietario o un director pueden otorgar acceso a un sitio.', {
      domain_code: 'site_access_grant_forbidden',
    });
  }
}
