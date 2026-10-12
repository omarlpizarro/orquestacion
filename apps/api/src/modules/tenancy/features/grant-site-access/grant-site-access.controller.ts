import { Controller, Logger } from '@nestjs/common';
import { Implement, implement } from '@orpc/nest';
import { contract } from '@orq/contracts';
import { rethrowDomainError } from '../../../../shared/errors/orpc-domain-error.js';
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
        // Los errores de este slice son casos finos de los códigos genéricos que
        // ya declara `base` (CLAUDE.md §8); `domain_code` los distingue.
        return rethrowDomainError(error, errors, this.logger, 'grant-site-access');
      }
    });
  }
}
