import { describe, expect, it, vi } from 'vitest';
import type { TransactionService } from '../../../../shared/database/transaction.service.js';
import { runWithRequestContext } from '../../../../shared/request-context/request-context.js';
import { DatabaseMisconfiguredError } from './database-misconfigured.error.js';
import { GetHealthHandler } from './get-health.handler.js';

interface Row {
  connected_as: string;
  server_time_utc: string;
  org_unset: boolean;
}

function buildHandler(row: Row | undefined, appRole = 'app_login') {
  const withSystem = vi.fn(
    async (fn: (tx: { execute: () => Promise<{ rows: Row[] }> }) => unknown) =>
      fn({ execute: async () => ({ rows: row ? [row] : [] }) }),
  );
  // Test double: solo necesitamos el método que el handler usa.
  const transactions = { withSystem } as unknown as TransactionService;
  return new GetHealthHandler(transactions, { DATABASE_APP_ROLE: appRole } as never);
}

describe('GetHealthHandler', () => {
  it('devuelve ok cuando conecta como app_login y no hay org seteada', async () => {
    const handler = buildHandler({
      connected_as: 'app_login',
      server_time_utc: '2026-09-19T00:00:00.000Z',
      org_unset: true,
    });

    const result = await runWithRequestContext({ requestId: 'req-1' }, () => handler.execute());

    expect(result).toEqual({
      status: 'ok',
      requestId: 'req-1',
      database: {
        reachable: true,
        connectedAs: 'app_login',
        serverTimeUtc: '2026-09-19T00:00:00.000Z',
      },
    });
  });

  it('lanza DatabaseMisconfiguredError si conecta con otro rol', async () => {
    const handler = buildHandler({
      connected_as: 'app_owner',
      server_time_utc: '2026-09-19T00:00:00.000Z',
      org_unset: true,
    });

    await expect(
      runWithRequestContext({ requestId: 'req-1' }, () => handler.execute()),
    ).rejects.toBeInstanceOf(DatabaseMisconfiguredError);
  });

  it('lanza DatabaseMisconfiguredError si app.current_org quedó seteado', async () => {
    const handler = buildHandler({
      connected_as: 'app_login',
      server_time_utc: '2026-09-19T00:00:00.000Z',
      org_unset: false,
    });

    await expect(
      runWithRequestContext({ requestId: 'req-1' }, () => handler.execute()),
    ).rejects.toBeInstanceOf(DatabaseMisconfiguredError);
  });
});
