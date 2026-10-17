import { createDb } from '@orq/db';
import { installPgBoss, type PostgresHarness, startPostgresHarness } from '@orq/db/testing';
import { PgBoss } from 'pg-boss';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AUDIT_MAINTAIN_QUEUE,
  maintainAuditPartitions,
  startAuditMaintenance,
} from './audit-maintain.js';

/**
 * El job de particiones del audit (ADR-018) con la identidad de producción: `app_worker`,
 * contra el esquema `pgboss` instalado por el migrador, igual que en el servidor.
 */
describe('audit.maintain', () => {
  let harness: PostgresHarness;
  const workerPool = () => harness.workerPool;
  const db = () => createDb(workerPool());

  beforeAll(async () => {
    harness = await startPostgresHarness();
    await installPgBoss({
      connectionString: harness.ownerConnectionUri,
      pool: harness.ownerPool,
    });
  });

  afterAll(async () => {
    await harness.stop();
  });

  const partitionCount = async () => {
    const { rows } = await harness.superuserPool.query<{ n: number }>(
      "select count(*)::int as n from pg_inherits where inhparent = 'public.audit_log'::regclass",
    );
    return rows[0]?.n ?? 0;
  };

  it('como app_worker deja 12 meses por delante del actual y es idempotente', async () => {
    const first = await maintainAuditPartitions(db(), crypto.randomUUID());
    const countAfterFirst = await partitionCount();
    const second = await maintainAuditPartitions(db(), crypto.randomUUID());

    expect(first.monthsAhead).toBe(12);
    expect(first.beyondRetention).toEqual([]);
    expect(second).toEqual(first);
    expect(await partitionCount()).toBe(countAfterFirst);
  });

  it('con filas en la DEFAULT de un mes por crear, la función de base falla fuerte (23514): el job no lo arregla solo', async () => {
    // Mes actual + 13: más allá de las 13 particiones que crea la migración 0012, y dentro
    // de lo que el job pide. La carga la hace el superusuario (no está sujeto a RLS).
    await harness.superuserPool.query(`
      insert into audit_log (organization_id, entity_type, entity_id, action, changed, created_at)
      values (gen_random_uuid(), 'project', gen_random_uuid(), 'insert', '{}',
              date_trunc('month', now() at time zone 'UTC') + interval '13 months 3 days')
    `);
    const { rows } = await harness.superuserPool.query<{ n: number }>(
      'select count(*)::int as n from audit_log_default',
    );
    expect(rows[0]?.n).toBe(1);

    // Hace falta una partición más que las 13 del job para que el job la intente crear:
    // se sube con el dueño (la función de base admite 24).
    await expect(
      harness.ownerPool.query('select app_ensure_audit_partitions(current_date, 24)'),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('registrado en pg-boss: la cola corre, queda completada y hay un cron diario', async () => {
    const boss = new PgBoss({
      connectionString: harness.workerConnectionUri,
      migrate: false,
      createSchema: false,
    });
    boss.on('error', () => {});
    await boss.start();
    try {
      await startAuditMaintenance(boss, db());

      const deadline = Date.now() + 30_000;
      let state: string | undefined;
      while (Date.now() < deadline) {
        const { rows } = await harness.superuserPool.query<{ state: string }>(
          'select state from pgboss.job where name = $1 order by created_on desc limit 1',
          [AUDIT_MAINTAIN_QUEUE],
        );
        state = rows[0]?.state;
        if (state === 'completed' || state === 'failed') break;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      expect(state).toBe('completed');

      const schedule = await harness.superuserPool.query<{ cron: string }>(
        'select cron from pgboss.schedule where name = $1',
        [AUDIT_MAINTAIN_QUEUE],
      );
      expect(schedule.rows.map((row) => row.cron)).toEqual(['0 3 * * *']);
    } finally {
      await boss.stop({ graceful: false, close: true });
    }
  });
});
