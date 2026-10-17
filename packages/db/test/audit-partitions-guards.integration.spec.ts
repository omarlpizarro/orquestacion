import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type PostgresHarness, startPostgresHarness } from '../src/testing/postgres-harness.js';

/**
 * ADR-018: `app_ensure_audit_partitions` la llama `app_worker` (SECURITY DEFINER del
 * dueño), así que valida sus parámetros adentro. Una llamada fuera de rango falla con
 * `22023` y no crea nada.
 */
describe('app_ensure_audit_partitions: permiso de app_worker y guardas (0020)', () => {
  let harness: PostgresHarness;

  const callAsWorker = (from: string, months: string) =>
    harness.workerPool.query(`select app_ensure_audit_partitions(${from}, ${months})`);

  const partitionNames = async (): Promise<string[]> => {
    const { rows } = await harness.ownerPool.query<{ relname: string }>(
      `select c.relname from pg_inherits i
         join pg_class c on c.oid = i.inhrelid
        where i.inhparent = 'public.audit_log'::regclass
        order by 1`,
    );
    return rows.map((row) => row.relname);
  };

  const today = "(now() at time zone 'UTC')::date";

  beforeAll(async () => {
    harness = await startPostgresHarness();
  });

  afterAll(async () => {
    await harness.stop();
  });

  it('app_worker puede ejecutarla; app_login y PUBLIC no', async () => {
    const { rows } = await harness.ownerPool.query<{ worker: boolean; login: boolean }>(
      `select has_function_privilege('app_worker', 'public.app_ensure_audit_partitions(date,integer)', 'execute') as worker,
              has_function_privilege('app_login',  'public.app_ensure_audit_partitions(date,integer)', 'execute') as login`,
    );
    expect(rows[0]).toEqual({ worker: true, login: false });
  });

  it('desde app_worker crea las particiones que faltan, con RLS y sin UPDATE/DELETE, y es idempotente', async () => {
    const before = await partitionNames();

    await callAsWorker(today, '24');
    const after = await partitionNames();
    expect(after.length).toBe(25); // 24 meses más la DEFAULT
    expect(after.length).toBeGreaterThan(before.length);
    await callAsWorker(today, '24');
    expect((await partitionNames()).length).toBe(25);

    const { rows } = await harness.ownerPool.query<{
      relname: string;
      rls: boolean;
      forced: boolean;
      can_update: boolean;
      can_delete: boolean;
    }>(
      `select c.relname, c.relrowsecurity as rls, c.relforcerowsecurity as forced,
              has_table_privilege('app_user', c.oid, 'update') as can_update,
              has_table_privilege('app_user', c.oid, 'delete') as can_delete
         from pg_inherits i join pg_class c on c.oid = i.inhrelid
        where i.inhparent = 'public.audit_log'::regclass`,
    );
    for (const row of rows) {
      expect(row, row.relname).toMatchObject({
        rls: true,
        forced: true,
        can_update: false,
        can_delete: false,
      });
    }
  });

  describe('fuera de rango: falla con 22023 y no crea nada', () => {
    const cases: Array<[string, string, string]> = [
      ['p_months = 0', today, '0'],
      ['p_months = 25', today, '25'],
      ['p_months negativo', today, '-3'],
      ['p_months nulo', today, 'null'],
      ['p_from nulo', 'null', '1'],
      ['p_from dos meses atrás', `${today} - interval '2 months'`, '1'],
      ['p_from dos meses adelante', `${today} + interval '2 months'`, '1'],
      ['p_from en 2099', "'2099-03-01'", '1'],
    ];

    for (const [name, from, months] of cases) {
      it(name, async () => {
        const before = await partitionNames();
        const call = callAsWorker(from.startsWith('(') ? `(${from})::date` : from, months);
        await expect(call).rejects.toMatchObject({ code: '22023' });
        expect(await partitionNames()).toEqual(before);
      });
    }

    it('las mismas guardas rigen para el dueño (las migraciones)', async () => {
      const before = await partitionNames();
      await expect(
        harness.ownerPool.query("select app_ensure_audit_partitions('2099-03-01', 1)"),
      ).rejects.toMatchObject({ code: '22023' });
      expect(await partitionNames()).toEqual(before);
    });
  });

  describe('locks de una corrida sin nada que crear (el job corre todos los días)', () => {
    /** Tablas públicas sobre las que la transacción abierta tiene `AccessExclusiveLock`. */
    const exclusiveLocksTaken = async (pool: PostgresHarness['workerPool'], months: number) => {
      const client = await pool.connect();
      try {
        await client.query('begin');
        await client.query(
          `select app_ensure_audit_partitions((now() at time zone 'UTC')::date, ${months})`,
        );
        const { rows } = await client.query<{ relname: string }>(`
          select c.relname
            from pg_locks l
            join pg_class c on c.oid = l.relation
            join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
           where l.pid = pg_backend_pid() and l.mode = 'AccessExclusiveLock' and c.relkind in ('r', 'p')
           order by 1`);
        await client.query('rollback');
        return rows.map((row) => row.relname);
      } finally {
        client.release();
      }
    };

    it('la segunda corrida, sin nada que crear, no toma ningún AccessExclusiveLock', async () => {
      await callAsWorker(today, '13');
      expect(await exclusiveLocksTaken(harness.workerPool, 13)).toEqual([]);
    });

    it('una corrida que sí crea una partición bloquea solo las tablas del audit, nunca las de negocio', async () => {
      // El primer test de este archivo ya dejó las 24 particiones: se borra la última para
      // que esta corrida tenga algo que crear.
      const { rows } = await harness.superuserPool.query<{ name: string }>(
        "select 'audit_log_' || to_char(date_trunc('month', now() at time zone 'UTC') + interval '23 months', 'YYYY_MM') as name",
      );
      await harness.superuserPool.query(`drop table public.${rows[0]?.name ?? ''}`);

      const locked = await exclusiveLocksTaken(harness.workerPool, 24);
      expect(locked.length).toBeGreaterThan(0);
      expect(locked.filter((name) => !name.startsWith('audit_log'))).toEqual([]);
    });
  });

  it('el borde del rango, un mes atrás y un mes adelante, es válido', async () => {
    await callAsWorker(`(${today} - interval '1 month')::date`, '1');
    await callAsWorker(`(${today} + interval '1 month')::date`, '1');
  });
});
