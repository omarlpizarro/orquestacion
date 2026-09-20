import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '../src/client.js';
import { type PostgresHarness, startPostgresHarness } from '../src/testing/postgres-harness.js';
import { withTenantTransaction } from '../src/transaction.js';

/**
 * CLAUDE.md §7: el tercer parámetro `true` de `set_config` es "el bug más
 * grave que este sistema puede tener". Este test lo prueba por
 * comportamiento, no por lectura de código: un pool con `max: 1` garantiza
 * que toda consulta reutiliza el mismo backend de Postgres, así que si el
 * contexto de un tenant sobrevive fuera de su transacción, se lo detecta acá.
 * Si alguien borra el `true` en transaction.ts, este test se pone rojo.
 */
describe('contexto de transacción no filtra entre requests', () => {
  let harness: PostgresHarness;
  let pool: Pool;
  let db: Db;

  beforeAll(async () => {
    harness = await startPostgresHarness();
    pool = createPool({ connectionString: harness.appConnectionUri, max: 1 });
    db = createDb(pool);
  });

  afterEach(async () => {
    // Limpia cualquier config residual entre tests, sin depender del propio
    // mecanismo que estamos probando.
    await pool.query(`select set_config('app.current_org', NULL, false)`);
  });

  afterAll(async () => {
    await pool.end();
    await harness.stop();
  });

  it('tras una transacción commiteada, el contexto no sobrevive en la conexión reusada', async () => {
    await withTenantTransaction(
      db,
      { organizationId: randomUUID(), memberId: randomUUID(), requestId: randomUUID() },
      (tx) => tx.execute(sql`select 1`),
    );

    const result = await db.execute<{ org: string | null }>(
      sql`select current_setting('app.current_org', true) as org`,
    );
    expect(result.rows[0]?.org).toBeNull();
  });

  it('tras una transacción revertida, el contexto tampoco sobrevive', async () => {
    class Boom extends Error {}

    await expect(
      withTenantTransaction(
        db,
        { organizationId: randomUUID(), memberId: randomUUID(), requestId: randomUUID() },
        async (tx) => {
          await tx.execute(sql`select 1`);
          throw new Boom();
        },
      ),
    ).rejects.toBeInstanceOf(Boom);

    const result = await db.execute<{ org: string | null }>(
      sql`select current_setting('app.current_org', true) as org`,
    );
    expect(result.rows[0]?.org).toBeNull();
  });
});
