import { DomainError } from '../../../../shared/errors/domain-error.js';

export class MemberHasImplicitSiteAccessError extends DomainError {
  readonly code = 'UNPROCESSABLE_CONTENT';
  readonly httpStatus = 422;

  constructor(role: string) {
    super('Ese miembro ya trabaja en todos los sitios por su rol; no necesita acceso por sitio.', {
      domain_code: 'member_has_implicit_site_access',
      details: { role },
    });
  }
}
