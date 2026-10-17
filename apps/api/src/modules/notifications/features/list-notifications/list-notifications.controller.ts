import { Controller, Logger } from '@nestjs/common';
import { Implement, implement } from '@orpc/nest';
import { contract } from '@orq/contracts';
import { rethrowDomainError } from '../../../../shared/errors/orpc-domain-error.js';
import { ListNotificationsHandler } from './list-notifications.handler.js';

@Controller()
export class ListNotificationsController {
  private readonly logger = new Logger(ListNotificationsController.name);

  constructor(private readonly handler: ListNotificationsHandler) {}

  @Implement(contract.notifications.listNotifications)
  listNotifications() {
    return implement(contract.notifications.listNotifications).handler(
      async ({ input, errors }) => {
        try {
          return await this.handler.execute(input);
        } catch (error) {
          // Los errores de este slice son casos finos de los códigos genéricos que
          // ya declara `base` (CLAUDE.md §8); `domain_code` los distingue.
          return rethrowDomainError(error, errors, this.logger, 'list-notifications');
        }
      },
    );
  }
}
