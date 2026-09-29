import { Injectable } from '@nestjs/common';
import type { GrantSiteAccessOutput } from '@orq/contracts';
import type { Tx } from '@orq/db';
import { hasCapability } from '../../../../shared/auth/access-control.js';
import { insertMemberSiteAccess } from '../../../../shared/auth/member-site-access.js';
import { findPriorMutation, recordMutation } from '../../../../shared/database/mutation-log.js';
import {
  hasPostgresErrorCode,
  UNIQUE_VIOLATION,
} from '../../../../shared/database/postgres-errors.js';
import { TransactionService } from '../../../../shared/database/transaction.service.js';
import type { TenantIdentity } from '../../../../shared/request-context/request-context.js';
import { getRequestContext } from '../../../../shared/request-context/request-context.js';
import { MemberNotInOrganizationError } from '../../domain/errors/member-not-in-organization.error.js';
import { SiteAccessGrantForbiddenError } from '../../domain/errors/site-access-grant-forbidden.error.js';
import { SiteNotFoundError } from '../../domain/errors/site-not-found.error.js';
import {
  findMemberForTenant,
  findSiteForTenant,
} from '../../infrastructure/site-access.repository.js';
import type { GrantSiteAccessCommand } from './grant-site-access.command.js';

@Injectable()
export class GrantSiteAccessHandler {
  constructor(private readonly transactions: TransactionService) {}

  async execute(command: GrantSiteAccessCommand): Promise<GrantSiteAccessOutput> {
    const { tenant } = getRequestContext();
    if (!tenant) {
      throw new Error('grant-site-access requiere una sesión con organización activa.');
    }
    if (!hasCapability(tenant.role, { site: ['grant_access'] })) {
      throw new SiteAccessGrantForbiddenError();
    }

    await this.applyOrReplayMutation(command, tenant);

    // La respuesta se arma del pedido, no de una fila: la tabla no tiene id
    // propio, y un reintento tiene que devolver exactamente lo mismo.
    return { site_id: command.site_id, member_id: command.member_id };
  }

  /**
   * Mismo criterio que `create-task`: si dos pedidos con el mismo
   * `client_mutation_id` corren a la vez, ninguno ve la mutación del otro y
   * los dos intentan registrarla; la PK de `mutation_log` deja pasar a uno. El
   * que pierde no debe recibir un 500 sino el mismo resultado que el que
   * ganó.
   */
  private async applyOrReplayMutation(
    command: GrantSiteAccessCommand,
    tenant: TenantIdentity,
  ): Promise<void> {
    try {
      await this.transactions.withTenant((tx) => this.applyMutation(command, tenant, tx));
    } catch (error) {
      if (!hasPostgresErrorCode(error, UNIQUE_VIOLATION)) throw error;

      const prior = await this.transactions.withTenant((tx) =>
        findPriorMutation(tx, command.client_mutation_id),
      );
      // Sin mutación previa resuelta, la violación era por otra cosa: no se
      // disfraza.
      if (prior?.result !== 'applied') throw error;
    }
  }

  private async applyMutation(
    command: GrantSiteAccessCommand,
    tenant: TenantIdentity,
    tx: Tx,
  ): Promise<void> {
    const prior = await findPriorMutation(tx, command.client_mutation_id);
    if (prior?.result === 'applied') return;

    const site = await findSiteForTenant(tx, {
      organizationId: tenant.organizationId,
      siteId: command.site_id,
    });
    if (!site) throw new SiteNotFoundError(command.site_id);

    const member = await findMemberForTenant(tx, {
      organizationId: tenant.organizationId,
      memberId: command.member_id,
    });
    if (!member) throw new MemberNotInOrganizationError();

    // Cualquier miembro de la organización puede recibir una fila, también un
    // `owner` o un `director` (ADR-016): para ellos no cambia lo que pueden
    // hacer hoy, pero queda registrado que trabajan en ese sitio y no se
    // pierde si después cambian de rol. No hay nada que validar del rol acá.
    await insertMemberSiteAccess(tx, {
      organizationId: tenant.organizationId,
      memberId: command.member_id,
      siteId: command.site_id,
    });

    await recordMutation(tx, {
      clientMutationId: command.client_mutation_id,
      organizationId: tenant.organizationId,
      memberId: tenant.memberId,
      kind: 'site-access.grant',
      entityId: command.site_id,
      result: 'applied',
    });
  }
}
