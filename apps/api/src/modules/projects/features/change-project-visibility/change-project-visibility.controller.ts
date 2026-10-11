import { Controller, Logger } from '@nestjs/common';
import { Implement, implement } from '@orpc/nest';
import { contract } from '@orq/contracts';
import { rethrowDomainError } from '../../../../shared/errors/orpc-domain-error.js';
import { ChangeProjectVisibilityHandler } from './change-project-visibility.handler.js';

@Controller()
export class ChangeProjectVisibilityController {
  private readonly logger = new Logger(ChangeProjectVisibilityController.name);

  constructor(private readonly handler: ChangeProjectVisibilityHandler) {}

  @Implement(contract.projects.changeProjectVisibility)
  changeProjectVisibility() {
    return implement(contract.projects.changeProjectVisibility).handler(
      async ({ input, errors }) => {
        try {
          return await this.handler.execute(input);
        } catch (error) {
          // Los errores de este slice son casos finos de los códigos genéricos que
          // ya declara `base` (CLAUDE.md §8); `domain_code` los distingue.
          return rethrowDomainError(error, errors, this.logger, 'change-project-visibility');
        }
      },
    );
  }
}
