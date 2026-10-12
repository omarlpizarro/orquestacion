import { DomainError } from '../../../../shared/errors/domain-error.js';

/**
 * El cliente reusó el `id` de la novedad (UUIDv7) con un `client_mutation_id`
 * nuevo. Un reintento legítimo lleva el mismo `client_mutation_id` y no llega acá.
 */
export class TaskCommentIdTakenError extends DomainError {
  readonly code = 'CONFLICT';
  readonly httpStatus = 409;

  constructor(commentId: string) {
    super('Ya existe una novedad con ese id.', {
      domain_code: 'task_comment_id_taken',
      details: { commentId },
    });
  }
}
