import { Controller, Logger } from '@nestjs/common';
import { Implement, implement } from '@orpc/nest';
import { contract } from '@orq/contracts';
import { rethrowDomainError } from '../../../../shared/errors/orpc-domain-error.js';
import { RemoveProjectMemberHandler } from './remove-project-member.handler.js';

@Controller()
export class RemoveProjectMemberController {
  private readonly logger = new Logger(RemoveProjectMemberController.name);

  constructor(private readonly handler: RemoveProjectMemberHandler) {}

  @Implement(contract.projects.removeProjectMember)
  removeProjectMember() {
    return implement(contract.projects.removeProjectMember).handler(async ({ input, errors }) => {
      try {
        return await this.handler.execute(input);
      } catch (error) {
        // Los errores de este slice son casos finos de los códigos genéricos que
        // ya declara `base` (CLAUDE.md §8); `domain_code` los distingue.
        return rethrowDomainError(error, errors, this.logger, 'remove-project-member');
      }
    });
  }
}
