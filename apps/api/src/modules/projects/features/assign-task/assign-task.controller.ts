import { Controller, Logger } from '@nestjs/common';
import { Implement, implement } from '@orpc/nest';
import { contract } from '@orq/contracts';
import { rethrowDomainError } from '../../../../shared/errors/orpc-domain-error.js';
import { AssignTaskHandler } from './assign-task.handler.js';

@Controller()
export class AssignTaskController {
  private readonly logger = new Logger(AssignTaskController.name);

  constructor(private readonly handler: AssignTaskHandler) {}

  @Implement(contract.projects.assignTask)
  assignTask() {
    return implement(contract.projects.assignTask).handler(async ({ input, errors }) => {
      try {
        return await this.handler.execute(input);
      } catch (error) {
        // Los errores de este slice son casos finos de los códigos genéricos que
        // ya declara `base` (CLAUDE.md §8); `domain_code` los distingue.
        return rethrowDomainError(error, errors, this.logger, 'assign-task');
      }
    });
  }
}
