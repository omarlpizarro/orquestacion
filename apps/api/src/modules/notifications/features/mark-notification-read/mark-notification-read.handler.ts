import { Injectable } from '@nestjs/common';
import type { NotificationOutput } from '@orq/contracts';
import type { Tx } from '@orq/db';
import { hasCapability } from '../../../../shared/auth/access-control.js';
import { claimMutation } from '../../../../shared/database/mutation-log.js';
import { TransactionService } from '../../../../shared/database/transaction.service.js';
import {
  getRequestContext,
  type TenantIdentity,
} from '../../../../shared/request-context/request-context.js';
import { NotificationForbiddenError } from '../../domain/errors/notification-forbidden.error.js';
import { NotificationNotFoundError } from '../../domain/errors/notification-not-found.error.js';
import {
  findNotification,
  markNotificationRead,
} from '../../infrastructure/notification.repository.js';
import { toNotificationOutput } from '../../infrastructure/notification-output.mapper.js';
import type { MarkNotificationReadCommand } from './mark-notification-read.command.js';

@Injectable()
export class MarkNotificationReadHandler {
  constructor(private readonly transactions: TransactionService) {}

  async execute(command: MarkNotificationReadCommand): Promise<NotificationOutput> {
    const { tenant } = getRequestContext();
    if (!tenant) {
      throw new Error('mark-notification-read requiere una sesión con organización activa.');
    }
    if (!hasCapability(tenant.role, { notification: ['read'] })) {
      throw new NotificationForbiddenError();
    }
    return this.transactions.withTenant((tx) => this.applyMutation(command, tenant, tx));
  }

  private async applyMutation(
    command: MarkNotificationReadCommand,
    tenant: TenantIdentity,
    tx: Tx,
  ): Promise<NotificationOutput> {
    const { organizationId, memberId } = tenant;

    // Primera sentencia de la transacción (ADR-007).
    const claim = await claimMutation(tx, {
      clientMutationId: command.client_mutation_id,
      organizationId,
      memberId,
      kind: 'notification.mark-read',
      entityId: command.id,
    });

    // Marcar de nuevo uno ya leído no cambia nada: ni `read_at` ni `version`. Un reintento
    // (`!claimed`) cae en el mismo camino: lee el aviso tal como quedó.
    const updated = claim.claimed
      ? await markNotificationRead(tx, { organizationId, memberId, notificationId: command.id })
      : null;
    if (updated) return toNotificationOutput(updated);

    // 404 si no existe o no es de quien pide, sin distinguir cuál de las dos (la base ya lo
    // oculta con la policy por destinatario).
    const current = await findNotification(tx, {
      organizationId,
      memberId,
      notificationId: command.id,
    });
    if (!current) throw new NotificationNotFoundError(command.id);
    return toNotificationOutput(current);
  }
}
