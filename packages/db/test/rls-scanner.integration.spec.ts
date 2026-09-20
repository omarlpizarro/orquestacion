import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/client.js';
import { type PostgresHarness, startPostgresHarness } from '../src/testing/postgres-harness.js';
import { scanTenantTables } from '../src/testing/rls-scanner.js';

/**
 * Meta-test: prueba que el detector detecta. Sin esto, el test de
 * aislamiento de `tenant-isolation.integration.spec.ts` pasaría de forma
 * vacía para siempre si `scanTenantTables` estuviera roto, porque hoy no hay
 * tablas de negocio reales. Cada sonda crea una tabla de prueba dentro de
 * una transacción que se revierte al final: no deja rastro en el esquema.
 */

class RollbackSignal extends Error {}

async function inRolledBackTransaction(
  db: Db,
  fn: (tx: Parameters<Parameters<Db['transaction']>[0]>[0]) => Promise<void>,
): Promise<Awaited<ReturnType<typeof scanTenantTables>>> {
  let violations: Awaited<ReturnType<typeof scanTenantTables>> = [];
  try {
    await db.transaction(async (tx) => {
      await fn(tx);
      violations = await scanTenantTables(tx);
      throw new RollbackSignal();
    });
  } catch (error) {
    if (!(error instanceof RollbackSignal)) throw error;
  }
  return violations;
}

describe('scanTenantTables', () => {
  let harness: PostgresHarness;

  beforeAll(async () => {
    harness = await startPostgresHarness();
  });

  afterAll(async () => {
    await harness.stop();
  });

  it('marca RLS_NOT_ENABLED cuando falta ENABLE ROW LEVEL SECURITY', async () => {
    const violations = await inRolledBackTransaction(harness.ownerDb, async (tx) => {
      await tx.execute(sql`
        create table probe_no_rls (id uuid primary key, organization_id uuid not null)
      `);
    });

    const forTable = violations.filter((v) => v.table === 'probe_no_rls');
    expect(forTable).toEqual([{ table: 'probe_no_rls', code: 'RLS_NOT_ENABLED' }]);
  });

  it('marca RLS_NOT_FORCED cuando falta FORCE ROW LEVEL SECURITY', async () => {
    const violations = await inRolledBackTransaction(harness.ownerDb, async (tx) => {
      await tx.execute(sql`
        create table probe_not_forced (id uuid primary key, organization_id uuid not null)
      `);
      await tx.execute(sql`alter table probe_not_forced enable row level security`);
      await tx.execute(sql`
        create policy probe_not_forced_tenant_isolation on probe_not_forced
          using (organization_id = current_setting('app.current_org', true)::uuid)
          with check (organization_id = current_setting('app.current_org', true)::uuid)
      `);
    });

    const codes = violations.filter((v) => v.table === 'probe_not_forced').map((v) => v.code);
    expect(codes).toEqual(['RLS_NOT_FORCED']);
  });

  it('marca NO_WITH_CHECK_CLAUSE cuando la policy solo tiene USING', async () => {
    const violations = await inRolledBackTransaction(harness.ownerDb, async (tx) => {
      await tx.execute(sql`
        create table probe_using_only (id uuid primary key, organization_id uuid not null)
      `);
      await tx.execute(sql`alter table probe_using_only enable row level security`);
      await tx.execute(sql`alter table probe_using_only force row level security`);
      await tx.execute(sql`
        create policy probe_using_only_tenant_isolation on probe_using_only
          using (organization_id = current_setting('app.current_org', true)::uuid)
      `);
    });

    const codes = violations.filter((v) => v.table === 'probe_using_only').map((v) => v.code);
    expect(codes).toEqual(['NO_WITH_CHECK_CLAUSE']);
  });

  it('no marca nada para una tabla correctamente aislada', async () => {
    const violations = await inRolledBackTransaction(harness.ownerDb, async (tx) => {
      await tx.execute(sql`
        create table probe_correct (id uuid primary key, organization_id uuid not null)
      `);
      await tx.execute(sql`alter table probe_correct enable row level security`);
      await tx.execute(sql`alter table probe_correct force row level security`);
      await tx.execute(sql`
        create policy probe_correct_tenant_isolation on probe_correct
          using (organization_id = current_setting('app.current_org', true)::uuid)
          with check (organization_id = current_setting('app.current_org', true)::uuid)
      `);
    });

    expect(violations.filter((v) => v.table === 'probe_correct')).toEqual([]);
  });
});
