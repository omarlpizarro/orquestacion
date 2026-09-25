import { DomainError } from '../../../../shared/errors/domain-error.js';

export class BlockReasonRequiredError extends DomainError {
  readonly code = 'UNPROCESSABLE_CONTENT';
  readonly httpStatus = 422;

  constructor() {
    super('Para bloquear una tarea hay que indicar el motivo.', {
      domain_code: 'block_reason_required',
    });
  }
}
