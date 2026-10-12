import { Controller, Logger } from '@nestjs/common';
import { Implement, implement } from '@orpc/nest';
import { contract } from '@orq/contracts';
import { rethrowDomainError } from '../../../../shared/errors/orpc-domain-error.js';
import { ChangeTaskStatusHandler } from './change-task-status.handler.js';

@Controller()
export class ChangeTaskStatusController {
  private readonly logger = new Logger(ChangeTaskStatusController.name);

  constructor(private readonly handler: ChangeTaskStatusHandler) {}

  @Implement(contract.projects.changeTaskStatus)
  changeTaskStatus() {
    return implement(contract.projects.changeTaskStatus).handler(async ({ input, errors }) => {
      try {
        return await this.handler.execute(input);
      } catch (error) {
        // Los errores de este slice son casos finos de los códigos genéricos que
        // ya declara `base` (CLAUDE.md §8); `domain_code` los distingue.
        return rethrowDomainError(error, errors, this.logger, 'change-task-status');
      }
    });
  }
}
