import { DomainError } from '../../../../shared/errors/domain-error.js';

/**
 * El `site_id` viene en el cuerpo del pedido, no en la ruta: un sitio que no
 * existe es un pedido que no se puede aplicar (422), no un recurso pedido que
 * falta (404).
 */
export class ProjectSiteNotFoundError extends DomainError {
  readonly code = 'UNPROCESSABLE_CONTENT';
  readonly httpStatus = 422;

  constructor(siteId: string) {
    super('El sitio indicado no existe.', {
      domain_code: 'project_site_not_found',
      details: { siteId },
    });
  }
}
