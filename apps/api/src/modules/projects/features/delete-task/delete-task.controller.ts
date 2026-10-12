import { Controller, Logger } from '@nestjs/common';
import { Implement, implement } from '@orpc/nest';
import { contract } from '@orq/contracts';
import { rethrowDomainError } from '../../../../shared/errors/orpc-domain-error.js';
import { DeleteTaskHandler } from './delete-task.handler.js';

@Controller()
export class DeleteTaskController {
  private readonly logger = new Logger(DeleteTaskController.name);

  constructor(private readonly handler: DeleteTaskHandler) {}

  @Implement(contract.projects.deleteTask)
  deleteTask() {
    return implement(contract.projects.deleteTask).handler(async ({ input, errors }) => {
      try {
        return await this.handler.execute(input);
      } catch (error) {
        // Los errores de este slice son casos finos de los códigos genéricos que
        // ya declara `base` (CLAUDE.md §8); `domain_code` los distingue.
        return rethrowDomainError(error, errors, this.logger, 'delete-task');
      }
    });
  }
}
