import { Controller, Logger } from '@nestjs/common';
import { Implement, implement } from '@orpc/nest';
import { contract } from '@orq/contracts';
import { rethrowDomainError } from '../../../../shared/errors/orpc-domain-error.js';
import { ListProjectsHandler } from './list-projects.handler.js';

@Controller()
export class ListProjectsController {
  private readonly logger = new Logger(ListProjectsController.name);

  constructor(private readonly handler: ListProjectsHandler) {}

  @Implement(contract.projects.listProjects)
  listProjects() {
    return implement(contract.projects.listProjects).handler(async ({ input, errors }) => {
      try {
        return await this.handler.execute(input);
      } catch (error) {
        // Los errores de este slice son casos finos de los códigos genéricos que
        // ya declara `base` (CLAUDE.md §8); `domain_code` los distingue.
        return rethrowDomainError(error, errors, this.logger, 'list-projects');
      }
    });
  }
}
