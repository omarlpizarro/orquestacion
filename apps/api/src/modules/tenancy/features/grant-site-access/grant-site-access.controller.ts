import { Controller, Logger } from '@nestjs/common';
import { Implement, implement } from '@orpc/nest';
import { contract, domainErrorData } from '@orq/contracts';
import { DomainError } from '../../../../shared/errors/domain-error.js';
import { GrantSiteAccessHandler } from './grant-site-access.handler.js';

@Controller()
export class GrantSiteAccessController {
  private readonly logger = new Logger(GrantSiteAccessController.name);

  constructor(private readonly handler: GrantSiteAccessHandler) {}

  @Implement(contract.tenancy.grantSiteAccess)
  grantSiteAccess() {
    return implement(contract.tenancy.grantSiteAccess).handler(async ({ input, errors }) => {
      try {
        return await this.handler.execute(input);
      } catch (error) {
        // Genérico a propósito, igual que create-task y change-task-status:
        // los casos de este slice son casos finos de los códigos que ya
        // declara `base` (CLAUDE.md §8).
        if (error instanceof DomainError) {
          const respond = errors[error.code as keyof typeof errors];
          if (!respond) {
            this.logger.error(
              `DomainError con code "${error.code}" no está declarado en el contrato de grant-site-access.`,
            );
            throw errors.UNPROCESSABLE_CONTENT({
              message: error.message,
              data: { domain_code: 'unmapped_domain_error' },
            });
          }
          throw respond({ message: error.message, data: domainErrorData.parse(error.data) });
        }
        throw error;
      }
    });
  }
}
