import { DomainError } from '../../../../shared/errors/domain-error.js';

/**
 * Mismo error para un miembro que no existe y para uno que existe pero es de
 * otra organización: distinguirlos le diría a quien pregunta qué ids son
 * reales en otros tenants.
 */
export class MemberNotInOrganizationError extends DomainError {
  readonly code = 'UNPROCESSABLE_CONTENT';
  readonly httpStatus = 422;

  constructor() {
    super('El miembro no pertenece a esta organización.', {
      domain_code: 'member_not_in_organization',
    });
  }
}
