import { sql } from 'drizzle-orm';
import type { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDb, createPool } from '../src/client.js';
import { type PostgresHarness, startPostgresHarness } from '../src/testing/postgres-harness.js';

/**
 * Sin `pool.on('error')`, una conexión ociosa que Postgres corta tira una
 * excepción no capturada y se cae el proceso (la API, el worker, un script),
 * aunque pg-pool ya haya descartado la conexión rota y la siguiente consulta
 * funcione. Esto reproduce el corte a propósito, con el superusuario, y
 * verifica que no hay excepción y que el pool sigue sirviendo.
 */
describe('pool con listener de error (conexión ociosa cortada por el servidor)', () => {
  let harness: PostgresHarness;
  let pool: Pool;
  const uncaught: unknown[] = [];
  const onUncaught = (error: unknown) => uncaught.push(error);
  const applicationName = 'pool_error_listener_test';

  beforeAll(async () => {
    harness = await startPostgresHarness();
  });

  afterAll(async () => {
    await harness.stop();
  });

  beforeEach(() => {
    uncaught.length = 0;
    process.on('uncaughtException', onUncaught);
    process.on('unhandledRejection', onUncaught);
  });

  afterEach(async () => {
    process.off('uncaughtException', onUncaught);
    process.off('unhandledRejection', onUncaught);
    vi.restoreAllMocks();
    await pool?.end();
  });

  async function openIdleConnections(count: number) {
    const db = createDb(pool);
    // Consultas a la vez, para que el pool abra `count` conexiones, y después queden ociosas.
    await Promise.all(
      Array.from({ length: count }, () => db.execute(sql`select pg_sleep(0.2), 1`)),
    );
    expect(pool.idleCount).toBe(count);
  }

  async function terminateBackendsOfThePool(): Promise<number> {
    const result = await harness.superuserPool.query<{ terminated: boolean }>(
      `select pg_terminate_backend(pid) as terminated
         from pg_stat_activity
        where application_name = $1 and pid <> pg_backend_pid()`,
      [applicationName],
    );
    return result.rows.filter((row) => row.terminated).length;
  }

  it('cortar las conexiones ociosas no tira una excepción, queda en el log con el nombre del pool, y la consulta siguiente anda', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    pool = createPool(
      { connectionString: harness.appConnectionUri, application_name: applicationName },
      'test:pool-error-listener',
    );
    await openIdleConnections(3);

    const terminated = await terminateBackendsOfThePool();
    expect(terminated).toBe(3);
    // El servidor avisa con un FATAL 57P01 a cada cliente ocioso y pg-pool los
    // descarta solo: se espera a que el pool no tenga ninguno.
    await vi.waitFor(() => expect(pool.totalCount).toBe(0), { timeout: 10_000 });

    expect(uncaught).toEqual([]);
    expect(logged).toHaveBeenCalledTimes(3);
    for (const [line] of logged.mock.calls) {
      expect(line).toContain('[pg-pool test:pool-error-listener]');
      expect(line).toContain('(57P01)');
    }

    const next = await createDb(pool).execute<{ ok: number }>(sql`select 1 as ok`);
    expect(next.rows[0]?.ok).toBe(1);
  });
});
