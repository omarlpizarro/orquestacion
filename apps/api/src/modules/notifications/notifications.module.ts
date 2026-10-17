import { Module } from '@nestjs/common';
import { ListNotificationsController } from './features/list-notifications/list-notifications.controller.js';
import { ListNotificationsHandler } from './features/list-notifications/list-notifications.handler.js';
import { MarkNotificationReadController } from './features/mark-notification-read/mark-notification-read.controller.js';
import { MarkNotificationReadHandler } from './features/mark-notification-read/mark-notification-read.handler.js';
import { NotificationsService } from './notifications.service.js';

@Module({
  controllers: [ListNotificationsController, MarkNotificationReadController],
  providers: [ListNotificationsHandler, MarkNotificationReadHandler, NotificationsService],
  exports: [NotificationsService],
})
export class NotificationsModule {}

// Otro módulo solo puede importar el archivo de módulo de este, nunca sus
// internals (CLAUDE.md §5, dependency-cruiser `no-cross-module-internals`).
export { NotificationsService } from './notifications.service.js';
