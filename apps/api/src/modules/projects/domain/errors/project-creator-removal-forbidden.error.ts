import { DomainError } from '../../../../shared/errors/domain-error.js';

/**
 * ADR-017 §8: cuando lo quita otra persona, al creador lo quitan solo `owner`
 * o `director`. Él mismo puede salirse, como cualquier miembro.
 */
export class ProjectCreatorRemovalForbiddenError extends DomainError {
  readonly code = 'FORBIDDEN';
  readonly httpStatus = 403;

  constructor() {
    super('Al creador del proyecto solo lo pueden quitar un owner o un director.', {
      domain_code: 'project_creator_removal_forbidden',
    });
  }
}
