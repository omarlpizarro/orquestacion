import { Controller, Logger } from '@nestjs/common';
import { Implement, implement } from '@orpc/nest';
import { contract } from '@orq/contracts';
import { rethrowDomainError } from '../../../../shared/errors/orpc-domain-error.js';
import { GetMemberNamesHandler } from './get-member-names.handler.js';

@Controller()
export class GetMemberNamesController {
  private readonly logger = new Logger(GetMemberNamesController.name);

  constructor(private readonly handler: GetMemberNamesHandler) {}

  @Implement(contract.tenancy.getMemberNames)
  getMemberNames() {
    return implement(contract.tenancy.getMemberNames).handler(async ({ input, errors }) => {
      try {
        return await this.handler.execute(input);
      } catch (error) {
        // Los errores de este slice son casos finos de los códigos genéricos que
        // ya declara `base` (CLAUDE.md §8); `domain_code` los distingue.
        return rethrowDomainError(error, errors, this.logger, 'get-member-names');
      }
    });
  }
}
