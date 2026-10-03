import { PgBoss } from 'pg-boss';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { installPgBoss } from '../src/pgboss-install.js';
import { type PostgresHarness, startPostgresHarness } from '../src/testing/postgres-harness.js';

/**
 * El esquema `pgboss` lo instala el migrador (app_owner) y el worker lo usa
 * como app_worker, que no es dueño. Esto verifica las dos mitades juntas, con
 * las opciones exactas que usa `apps/worker`.
 */
describe('pg-boss instalado por el migrador y usado por app_worker', () => {
  let harness: PostgresHarness;

  const workerBoss = () =>
    new PgBoss({
      connectionString: harness.workerConnectionUri,
      migrate: false,
      createSchema: false,
    });

  beforeAll(async () => {
    harness = await startPostgresHarness();
  });

  afterAll(async () => {
    await harness.stop();
  });

  it('el worker falla fuerte si el esquema todavía no está instalado', async () => {
    const boss = workerBoss();
    boss.on('error', () => {});
    await expect(boss.start()).rejects.toThrow(/not installed|migrations/i);
    await boss.stop({ graceful: false, close: true });
  });

  it('instala el esquema, termina (no deja el proceso colgado) y es repetible', async () => {
    const done = installPgBoss({
      connectionString: harness.ownerConnectionUri,
      pool: harness.ownerPool,
    });
    await expect(done).resolves.toBeUndefined();
    await expect(
      installPgBoss({ connectionString: harness.ownerConnectionUri, pool: harness.ownerPool }),
    ).resolves.toBeUndefined();
  });

  it('app_worker encola y procesa trabajos sin ser dueño del esquema', async () => {
    const boss = workerBoss();
    boss.on('error', () => {});
    await boss.start();
    try {
      await boss.createQueue('prueba');
      const received = new Promise<string>((resolve) => {
        void boss.work<{ valor: string }>('prueba', async ([job]) => {
          resolve(job?.data.valor ?? '');
        });
      });
      await boss.send('prueba', { valor: 'hola' });
      await expect(received).resolves.toBe('hola');
    } finally {
      await boss.stop({ graceful: false, close: true });
    }
  });

  it('los permisos cubren tablas que aparezcan después (default privileges)', async () => {
    await harness.ownerPool.query('create table pgboss.tabla_de_una_actualizacion (id int)');
    const { rows } = await harness.workerPool.query(
      "select has_table_privilege('app_worker', 'pgboss.tabla_de_una_actualizacion', 'select, insert, update, delete') as ok",
    );
    expect(rows[0]?.ok).toBe(true);
  });

  it('app_worker no tiene DDL en el esquema (por eso no se usan colas particionadas)', async () => {
    const { rows } = await harness.workerPool.query(
      "select has_schema_privilege('app_worker', 'pgboss', 'create') as can_create",
    );
    expect(rows[0]?.can_create).toBe(false);
  });
});
