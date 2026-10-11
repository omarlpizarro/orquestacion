import { Controller, Logger } from '@nestjs/common';
import { Implement, implement } from '@orpc/nest';
import { contract } from '@orq/contracts';
import { rethrowDomainError } from '../../../../shared/errors/orpc-domain-error.js';
import { AddProjectMemberHandler } from './add-project-member.handler.js';

@Controller()
export class AddProjectMemberController {
  private readonly logger = new Logger(AddProjectMemberController.name);

  constructor(private readonly handler: AddProjectMemberHandler) {}

  @Implement(contract.projects.addProjectMember)
  addProjectMember() {
    return implement(contract.projects.addProjectMember).handler(async ({ input, errors }) => {
      try {
        return await this.handler.execute(input);
      } catch (error) {
        // Los errores de este slice son casos finos de los códigos genéricos que
        // ya declara `base` (CLAUDE.md §8); `domain_code` los distingue.
        return rethrowDomainError(error, errors, this.logger, 'add-project-member');
      }
    });
  }
}
