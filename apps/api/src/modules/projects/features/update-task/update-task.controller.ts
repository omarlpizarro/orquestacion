import { Controller, Logger } from '@nestjs/common';
import { Implement, implement } from '@orpc/nest';
import { contract } from '@orq/contracts';
import { rethrowDomainError } from '../../../../shared/errors/orpc-domain-error.js';
import { UpdateTaskHandler } from './update-task.handler.js';

@Controller()
export class UpdateTaskController {
  private readonly logger = new Logger(UpdateTaskController.name);

  constructor(private readonly handler: UpdateTaskHandler) {}

  @Implement(contract.projects.updateTask)
  updateTask() {
    return implement(contract.projects.updateTask).handler(async ({ input, errors }) => {
      try {
        return await this.handler.execute(input);
      } catch (error) {
        // Los errores de este slice son casos finos de los códigos genéricos que
        // ya declara `base` (CLAUDE.md §8); `domain_code` los distingue.
        return rethrowDomainError(error, errors, this.logger, 'update-task');
      }
    });
  }
}
