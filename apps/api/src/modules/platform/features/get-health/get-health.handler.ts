import { Inject, Injectable } from '@nestjs/common';
import type { HealthOutput } from '@orq/contracts';
import { sql } from 'drizzle-orm';
import { SERVER_ENV, type ServerEnv } from '../../../../shared/config/config.module.js';
import { TransactionService } from '../../../../shared/database/transaction.service.js';
import { getRequestContext } from '../../../../shared/request-context/request-context.js';
import { DatabaseMisconfiguredError } from './database-misconfigured.error.js';

interface HealthRow extends Record<string, unknown> {
  connected_as: string;
  server_time_utc: string;
  org_unset: boolean;
}

/**
 * No recibe un tenant falso: corre por `withSystem`, que deliberadamente no
 * setea `app.current_org`. Así, un `DATABASE_URL` apuntando al dueño del
 * esquema (en vez de a `app_login`) pone este check en rojo el día uno, no
 * en el mes seis.
 */
@Injectable()
export class GetHealthHandler {
  constructor(
    private readonly transactions: TransactionService,
    @Inject(SERVER_ENV) private readonly env: ServerEnv,
  ) {}

  async execute(): Promise<HealthOutput> {
    const { requestId } = getRequestContext();

    const row = await this.transactions.withSystem(async (tx) => {
      const result = await tx.execute<HealthRow>(sql`
        select
          current_user as connected_as,
          (now() at time zone 'utc')::text as server_time_utc,
          (current_setting('app.current_org', true) is null) as org_unset
      `);
      return result.rows[0];
    });

    if (!row || row.connected_as !== this.env.DATABASE_APP_ROLE || !row.org_unset) {
      throw new DatabaseMisconfiguredError(row?.connected_as);
    }

    return {
      status: 'ok',
      requestId,
      database: {
        reachable: true,
        connectedAs: row.connected_as,
        serverTimeUtc: row.server_time_utc,
      },
    };
  }
}
