import { DomainError } from '../../../../shared/errors/domain-error.js';

/**
 * ADR-017 §8: al creador lo quitan solo `owner` o `director`, y no puede
 * salirse por su cuenta.
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
