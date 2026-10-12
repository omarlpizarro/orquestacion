import { DomainError } from './domain-error.js';

/**
 * El `client_mutation_id` ya está registrado, pero no se puede leer lo que
 * registró: lo usó otra organización (RLS esconde esa fila). Es un id de cliente
 * (UUIDv7) repetido, no un reintento. Sin detalles a propósito: no se le dice a
 * quien lo mandó de quién era.
 */
export class MutationIdReusedError extends DomainError {
  readonly code = 'CONFLICT';
  readonly httpStatus = 409;

  constructor() {
    super('Ese identificador de operación ya se usó. Generá uno nuevo para cada operación.', {
      domain_code: 'client_mutation_id_reused',
    });
  }
}
