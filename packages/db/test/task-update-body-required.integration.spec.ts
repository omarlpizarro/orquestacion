import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { insertAuthMember, insertAuthOrganization } from '../src/testing/auth-fixtures.js';
import { type PostgresHarness, startPostgresHarness } from '../src/testing/postgres-harness.js';
import { type Tx, withTenantTransaction } from '../src/transaction.js';

/**
 * `task_update_body_required_check` (0017, agregada `NOT VALID`): comentario,
 * reporte de bloqueo y reapertura exigen `body` con al menos un carácter que no
 * sea espacio en blanco (`body ~ '[^[:space:]]'`). Rige para toda fila nueva
 * aunque todavía no se haya validado el historial.
 */
describe('task_update exige texto real para comment, block_report y reopen', () => {
  let harness: PostgresHarness;
  const suffix = randomUUID().replaceAll('-', '');
  const organizationId = `org_${suffix}`;
  const ownerId = `owner_${suffix}`;
  let taskId: string;

  const insertUpdate = (tx: Tx, kind: string, body: string | null) =>
    tx.execute(sql`
      insert into task_update (id, organization_id, created_by_member_id, task_id, project_id, kind, body)
      select ${randomUUID()}, ${organizationId}, ${ownerId}, t.id, t.project_id, ${kind}, ${body}
        from task t where t.id = ${taskId}
    `);
  const inTenant = <T>(run: (tx: Tx) => Promise<T>) =>
    withTenantTransaction(
      harness.db,
      { organizationId, memberId: ownerId, requestId: randomUUID() },
      run,
    );

  beforeAll(async () => {
    harness = await startPostgresHarness();
    await insertAuthOrganization(harness.ownerDb, { id: organizationId });
    await insertAuthMember(harness.ownerDb, { organizationId, memberId: ownerId, role: 'owner' });
    const siteId = randomUUID();
    const projectId = randomUUID();
    taskId = randomUUID();
    await inTenant(async (tx) => {
      await tx.execute(sql`
        insert into site (id, organization_id, name, timezone)
        values (${siteId}, ${organizationId}, 'Sitio', 'America/Argentina/Buenos_Aires')
      `);
      await tx.execute(sql`
        insert into project (id, organization_id, site_id, created_by_member_id, code, name, visibility)
        values (${projectId}, ${organizationId}, ${siteId}, ${ownerId}, 'PRY-1', 'P', 'site')
      `);
      await tx.execute(sql`
        insert into task (id, organization_id, created_by_member_id, project_id, title, position)
        values (${taskId}, ${organizationId}, ${ownerId}, ${projectId}, 'T', 'a0')
      `);
    });
  });

  afterAll(async () => {
    await harness.stop();
  });

  // `%j` imprime el valor como JSON, así que los tabuladores y saltos de línea se ven escapados.
  const withoutText: Array<string | null> = [null, '', ' ', '     ', '\t', '\n', '\r\n', ' \t\n '];
  const kindsThatNeedText = ['comment', 'block_report', 'reopen'];

  describe.each(kindsThatNeedText)('%s', (kind) => {
    it.each(withoutText)('se rechaza body %j (23514)', async (body) => {
      await expect(inTenant((tx) => insertUpdate(tx, kind, body))).rejects.toMatchObject({
        cause: { code: '23514', constraint: 'task_update_body_required_check' },
      });
    });

    it.each(['  Falta el permiso  ', '\t\nFalta el permiso\r\n', '?'])(
      'se acepta con texto %j',
      async (body) => {
        await expect(inTenant((tx) => insertUpdate(tx, kind, body))).resolves.toBeDefined();
      },
    );
  });

  describe.each(['status_change', 'evidence', 'system'])('%s: no exige texto', (kind) => {
    it.each([null, '', ' ', '\t\n'])('puede ir con body %j', async (body) => {
      await expect(inTenant((tx) => insertUpdate(tx, kind, body))).resolves.toBeDefined();
    });
  });

  it('la constraint quedó validada por la migración 0018 (no solo agregada NOT VALID)', async () => {
    const result = await harness.superuserPool.query<{ convalidated: boolean }>(
      "select convalidated from pg_constraint where conname = 'task_update_body_required_check'",
    );

    expect(result.rows).toEqual([{ convalidated: true }]);
  });
});
