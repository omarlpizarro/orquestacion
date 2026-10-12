import { DomainError } from '../../../../shared/errors/domain-error.js';

/**
 * El código es único por organización. Lo detecta la restricción de la base:
 * un `SELECT` previo no ve los proyectos reservados ajenos (RLS), así que
 * revela que existe uno con ese código aunque no se pueda ver.
 */
export class ProjectCodeTakenError extends DomainError {
  readonly code = 'CONFLICT';
  readonly httpStatus = 409;

  constructor(code: string) {
    super('Ya existe un proyecto con ese código en la organización.', {
      domain_code: 'project_code_taken',
      details: { code },
    });
  }
}
