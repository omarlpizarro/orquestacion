import { DomainError } from '../../../../shared/errors/domain-error.js';

/**
 * El cliente reusó el `id` (UUIDv7) con un `client_mutation_id` nuevo. Un
 * reintento legítimo lleva el mismo `client_mutation_id` y no llega acá.
 */
export class ProjectIdTakenError extends DomainError {
  readonly code = 'CONFLICT';
  readonly httpStatus = 409;

  constructor(projectId: string) {
    super('Ya existe un proyecto con ese id.', {
      domain_code: 'project_id_taken',
      details: { projectId },
    });
  }
}
