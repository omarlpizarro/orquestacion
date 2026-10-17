import { Injectable } from '@nestjs/common';
import type { ListNotificationsOutput } from '@orq/contracts';
import { hasCapability } from '../../../../shared/auth/access-control.js';
import { TransactionService } from '../../../../shared/database/transaction.service.js';
import { getRequestContext } from '../../../../shared/request-context/request-context.js';
import { NotificationForbiddenError } from '../../domain/errors/notification-forbidden.error.js';
import {
  decodeNotificationCursor,
  encodeNotificationCursor,
} from '../../domain/notification-cursor.js';
import {
  countUnreadNotifications,
  listNotifications,
} from '../../infrastructure/notification.repository.js';
import { toNotificationOutput } from '../../infrastructure/notification-output.mapper.js';
import type { ListNotificationsQuery } from './list-notifications.query.js';

@Injectable()
export class ListNotificationsHandler {
  constructor(private readonly transactions: TransactionService) {}

  async execute(query: ListNotificationsQuery): Promise<ListNotificationsOutput> {
    const { tenant } = getRequestContext();
    if (!tenant) {
      throw new Error('list-notifications requiere una sesión con organización activa.');
    }
    const { organizationId, memberId } = tenant;
    if (!hasCapability(tenant.role, { notification: ['read'] })) {
      throw new NotificationForbiddenError();
    }
    // Se valida antes de abrir la transacción: un cursor inválido no toca la base.
    const afterId = query.cursor ? decodeNotificationCursor(query.cursor) : null;

    return this.transactions.withTenant(async (tx) => {
      // Una de más, para saber si hay otra página sin una consulta extra.
      const rows = await listNotifications(tx, {
        organizationId,
        memberId,
        unreadOnly: query.unread_only ?? false,
        afterId,
        limit: query.limit + 1,
      });
      const page = rows.slice(0, query.limit);
      const last = page.at(-1);
      return {
        notifications: page.map(toNotificationOutput),
        next_cursor: rows.length > query.limit && last ? encodeNotificationCursor(last.id) : null,
        unread_count: await countUnreadNotifications(tx, { organizationId, memberId }),
      };
    });
  }
}
