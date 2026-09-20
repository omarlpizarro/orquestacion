import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type PostgresHarness, startPostgresHarness } from '../src/testing/postgres-harness.js';
import { withSystemTransaction, withTenantTransaction } from '../src/transaction.js';

/**
 * El test obligatorio de CLAUDE.md §10: ninguna organización puede leer o
 * escribir filas de otra. Usa una tabla correctamente aislada (el mismo
 * patrón que la sonda "correcta" de rls-scanner.integration.spec.ts) como
 * sujeto real, así el test no es vacío incluso sin tablas de negocio todavía.
 */
describe('aislamiento de tenant', () => {
  let harness: PostgresHarness;
  const orgA = randomUUID();
  const orgB = randomUUID();
  const memberA = randomUUID();
  const rowA = randomUUID();
  const rowB = randomUUID();

  beforeAll(async () => {
    harness = await startPostgresHarness();

    await harness.ownerDb.execute(sql`
      create table tenant_isolation_probe (
        id uuid primary key,
        organization_id uuid not null,
        label text not null
      )
    `);
    await harness.ownerDb.execute(
      sql`alter table tenant_isolation_probe enable row level security`,
    );
    await harness.ownerDb.execute(sql`alter table tenant_isolation_probe force row level security`);
    await harness.ownerDb.execute(sql`
      create policy tenant_isolation_probe_tenant_isolation on tenant_isolation_probe
        using (organization_id = current_setting('app.current_org', true)::uuid)
        with check (organization_id = current_setting('app.current_org', true)::uuid)
    `);
    await harness.ownerDb.execute(
      sql`grant select, insert, update, delete on tenant_isolation_probe to app_user`,
    );

    await withTenantTransaction(
      harness.db,
      { organizationId: orgA, memberId: memberA, requestId: randomUUID() },
      (tx) =>
        tx.execute(
          sql`insert into tenant_isolation_probe (id, organization_id, label) values (${rowA}, ${orgA}, 'de org A')`,
        ),
    );
    await withTenantTransaction(
      harness.db,
      { organizationId: orgB, memberId: memberA, requestId: randomUUID() },
      (tx) =>
        tx.execute(
          sql`insert into tenant_isolation_probe (id, organization_id, label) values (${rowB}, ${orgB}, 'de org B')`,
        ),
    );
  });

  afterAll(async () => {
    await harness.stop();
  });

  it('como org A, leer devuelve solo las filas de org A', async () => {
    const rows = await withTenantTransaction(
      harness.db,
      { organizationId: orgA, memberId: memberA, requestId: randomUUID() },
      (tx) => tx.execute(sql`select id, organization_id from tenant_isolation_probe`),
    );

    expect(rows.rows).toEqual([{ id: rowA, organization_id: orgA }]);
  });

  it('como org A, un UPDATE contra una fila de org B afecta cero filas', async () => {
    const result = await withTenantTransaction(
      harness.db,
      { organizationId: orgA, memberId: memberA, requestId: randomUUID() },
      (tx) =>
        tx.execute(sql`update tenant_isolation_probe set label = 'hackeado' where id = ${rowB}`),
    );

    expect(result.rowCount).toBe(0);

    const stillIntact = await withTenantTransaction(
      harness.db,
      { organizationId: orgB, memberId: memberA, requestId: randomUUID() },
      (tx) => tx.execute(sql`select label from tenant_isolation_probe where id = ${rowB}`),
    );
    expect((stillIntact.rows[0] as { label: string }).label).toBe('de org B');
  });

  it('como org A, un INSERT con organization_id de org B levanta 42501', async () => {
    await expect(
      withTenantTransaction(
        harness.db,
        { organizationId: orgA, memberId: memberA, requestId: randomUUID() },
        (tx) =>
          tx.execute(
            sql`insert into tenant_isolation_probe (id, organization_id, label) values (${randomUUID()}, ${orgB}, 'colado')`,
          ),
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('una transacción de sistema no ve ninguna fila de tenant', async () => {
    const result = await withSystemTransaction(harness.db, { requestId: randomUUID() }, (tx) =>
      tx.execute(sql`select id from tenant_isolation_probe`),
    );

    expect(result.rows).toEqual([]);
  });

  it('app_user y app_login no tienen superusuario ni BYPASSRLS, y app_user no puede conectarse', async () => {
    const result = await harness.ownerDb.execute<{
      rolname: string;
      rolsuper: boolean;
      rolbypassrls: boolean;
      rolcanlogin: boolean;
    }>(sql`
      select rolname, rolsuper, rolbypassrls, rolcanlogin
      from pg_roles
      where rolname in ('app_owner', 'app_user', 'app_login')
    `);

    const byName = Object.fromEntries(result.rows.map((r) => [r.rolname, r]));
    expect(byName.app_user).toMatchObject({
      rolsuper: false,
      rolbypassrls: false,
      rolcanlogin: false,
    });
    expect(byName.app_login).toMatchObject({ rolsuper: false, rolbypassrls: false });
  });

  it('ninguna tabla de public es propiedad de app_user o app_login', async () => {
    const result = await harness.ownerDb.execute<{ relname: string; owner: string }>(sql`
      select c.relname, pg_get_userbyid(c.relowner) as owner
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r'
    `);

    for (const row of result.rows) {
      expect(row.owner).not.toBe('app_user');
      expect(row.owner).not.toBe('app_login');
    }
  });
});
