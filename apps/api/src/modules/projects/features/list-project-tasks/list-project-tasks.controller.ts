import { Controller, Logger } from '@nestjs/common';
import { Implement, implement } from '@orpc/nest';
import { contract } from '@orq/contracts';
import { rethrowDomainError } from '../../../../shared/errors/orpc-domain-error.js';
import { ListProjectTasksHandler } from './list-project-tasks.handler.js';

@Controller()
export class ListProjectTasksController {
  private readonly logger = new Logger(ListProjectTasksController.name);

  constructor(private readonly handler: ListProjectTasksHandler) {}

  @Implement(contract.projects.listProjectTasks)
  listProjectTasks() {
    return implement(contract.projects.listProjectTasks).handler(async ({ input, errors }) => {
      try {
        return await this.handler.execute(input);
      } catch (error) {
        // Los errores de este slice son casos finos de los códigos genéricos que
        // ya declara `base` (CLAUDE.md §8); `domain_code` los distingue.
        return rethrowDomainError(error, errors, this.logger, 'list-project-tasks');
      }
    });
  }
}
