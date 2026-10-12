import { DomainError } from '../../../../shared/errors/domain-error.js';

/**
 * El sitio elegido pasa por `canAccessSite`, como en `create-task` (ADR-015).
 */
export class ProjectSiteAccessForbiddenError extends DomainError {
  readonly code = 'FORBIDDEN';
  readonly httpStatus = 403;

  constructor(siteId: string) {
    super('No tenés acceso a ese sitio.', {
      domain_code: 'project_site_access_forbidden',
      details: { siteId },
    });
  }
}
