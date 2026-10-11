import { DomainError } from '../../../../shared/errors/domain-error.js';

/**
 * Con un solo sitio activo se toma ese; con más de uno (o ninguno activo) lo
 * tiene que elegir quien crea el proyecto.
 */
export class ProjectSiteRequiredError extends DomainError {
  readonly code = 'UNPROCESSABLE_CONTENT';
  readonly httpStatus = 422;

  constructor() {
    super('La organización tiene más de un sitio: indicá en cuál se crea el proyecto.', {
      domain_code: 'project_site_required',
    });
  }
}
