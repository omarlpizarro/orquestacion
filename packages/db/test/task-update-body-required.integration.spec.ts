import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { insertAuthMember, insertAuthOrganization } from '../src/testing/auth-fixtures.js';
import { type PostgresHarness, startPostgresHarness } from '../src/testing/postgres-harness.js';
import { type Tx, withTenantTransaction } from '../src/transaction.js';

/**
 * `task_update_body_required_check` (0017, agregada `NOT VALID`): comentario,
 * reporte de bloqueo y reapertura exigen `body`. Rige para toda fila nueva
 * aunque todavía no se haya validado el historial.
 */
describe('task_update exige body para comment, block_report y reopen', () => {
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

  it.each(['comment', 'block_report', 'reopen'])('rechaza un %s sin body (23514)', async (kind) => {
    await expect(inTenant((tx) => insertUpdate(tx, kind, null))).rejects.toMatchObject({
      cause: { code: '23514', constraint: 'task_update_body_required_check' },
    });
  });

  it.each(['comment', 'block_report', 'reopen'])('acepta un %s con body', async (kind) => {
    await expect(
      inTenant((tx) => insertUpdate(tx, kind, 'Falta el permiso')),
    ).resolves.toBeDefined();
  });

  it.each(['status_change', 'evidence', 'system'])(
    'un %s puede ir sin body: no lo exige',
    async (kind) => {
      await expect(inTenant((tx) => insertUpdate(tx, kind, null))).resolves.toBeDefined();
    },
  );
});
