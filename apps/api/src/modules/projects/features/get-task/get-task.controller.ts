import { Controller, Logger } from '@nestjs/common';
import { Implement, implement } from '@orpc/nest';
import { contract } from '@orq/contracts';
import { rethrowDomainError } from '../../../../shared/errors/orpc-domain-error.js';
import { GetTaskHandler } from './get-task.handler.js';

@Controller()
export class GetTaskController {
  private readonly logger = new Logger(GetTaskController.name);

  constructor(private readonly handler: GetTaskHandler) {}

  @Implement(contract.projects.getTask)
  getTask() {
    return implement(contract.projects.getTask).handler(async ({ input, errors }) => {
      try {
        return await this.handler.execute(input);
      } catch (error) {
        // Los errores de este slice son casos finos de los códigos genéricos que
        // ya declara `base` (CLAUDE.md §8); `domain_code` los distingue.
        return rethrowDomainError(error, errors, this.logger, 'get-task');
      }
    });
  }
}
