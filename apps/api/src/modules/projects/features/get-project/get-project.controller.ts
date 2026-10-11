import { Controller, Logger } from '@nestjs/common';
import { Implement, implement } from '@orpc/nest';
import { contract } from '@orq/contracts';
import { rethrowDomainError } from '../../../../shared/errors/orpc-domain-error.js';
import { GetProjectHandler } from './get-project.handler.js';

@Controller()
export class GetProjectController {
  private readonly logger = new Logger(GetProjectController.name);

  constructor(private readonly handler: GetProjectHandler) {}

  @Implement(contract.projects.getProject)
  getProject() {
    return implement(contract.projects.getProject).handler(async ({ input, errors }) => {
      try {
        return await this.handler.execute(input);
      } catch (error) {
        // Los errores de este slice son casos finos de los códigos genéricos que
        // ya declara `base` (CLAUDE.md §8); `domain_code` los distingue.
        return rethrowDomainError(error, errors, this.logger, 'get-project');
      }
    });
  }
}
