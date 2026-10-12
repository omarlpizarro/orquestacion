import { Controller, Logger } from '@nestjs/common';
import { Implement, implement } from '@orpc/nest';
import { contract } from '@orq/contracts';
import { rethrowDomainError } from '../../../../shared/errors/orpc-domain-error.js';
import { CreateTaskHandler } from './create-task.handler.js';

@Controller()
export class CreateTaskController {
  private readonly logger = new Logger(CreateTaskController.name);

  constructor(private readonly handler: CreateTaskHandler) {}

  @Implement(contract.projects.createTask)
  createTask() {
    return implement(contract.projects.createTask).handler(async ({ input, errors }) => {
      try {
        return await this.handler.execute(input);
      } catch (error) {
        // Los errores de este slice son casos finos de los códigos genéricos que
        // ya declara `base` (CLAUDE.md §8); `domain_code` los distingue.
        return rethrowDomainError(error, errors, this.logger, 'create-task');
      }
    });
  }
}
