import { DomainError } from '../../../../shared/errors/domain-error.js';
import type { ReasonKind } from '../task-status.js';

const MESSAGES_BY_REASON_KIND: Record<ReasonKind, string> = {
  block_report: 'Para bloquear una tarea hay que indicar el motivo.',
  reopen: 'Para reabrir una tarea hay que indicar el motivo.',
};

export class ReasonRequiredError extends DomainError {
  readonly code = 'UNPROCESSABLE_CONTENT';
  readonly httpStatus = 422;

  constructor(reasonKind: ReasonKind) {
    super(MESSAGES_BY_REASON_KIND[reasonKind], {
      domain_code: 'reason_required',
      details: { reasonKind },
    });
  }
}
