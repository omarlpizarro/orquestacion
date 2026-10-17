import { Controller, Logger } from '@nestjs/common';
import { Implement, implement } from '@orpc/nest';
import { contract } from '@orq/contracts';
import { rethrowDomainError } from '../../../../shared/errors/orpc-domain-error.js';
import { MarkNotificationReadHandler } from './mark-notification-read.handler.js';

@Controller()
export class MarkNotificationReadController {
  private readonly logger = new Logger(MarkNotificationReadController.name);

  constructor(private readonly handler: MarkNotificationReadHandler) {}

  @Implement(contract.notifications.markNotificationRead)
  markNotificationRead() {
    return implement(contract.notifications.markNotificationRead).handler(
      async ({ input, errors }) => {
        try {
          return await this.handler.execute(input);
        } catch (error) {
          return rethrowDomainError(error, errors, this.logger, 'mark-notification-read');
        }
      },
    );
  }
}
