import { DomainError } from '../../../../shared/errors/domain-error.js';

export class SiteNotFoundError extends DomainError {
  readonly code = 'NOT_FOUND';
  readonly httpStatus = 404;

  constructor(siteId: string) {
    super('El sitio no existe.', { domain_code: 'site_not_found', details: { siteId } });
  }
}
