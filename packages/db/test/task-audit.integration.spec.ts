import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withSystemTransaction } from '../src/system-transaction.js';
import { insertAuthMember, insertAuthOrganization } from '../src/testing/auth-fixtures.js';
import { type PostgresHarness, startPostgresHarness } from '../src/testing/postgres-harness.js';
import { type Tx, withTenantTransaction } from '../src/transaction.js';

/**
 * Migración 0019: `task` queda auditada por el mismo trigger genérico que ya
 * audita `project` y `project_member`. La entrada hereda la visibilidad por
 * proyecto de `audit_log` (ADR-017 §3).
 */
describe('audit trail sobre task (0019)', () => {
  let harness: PostgresHarness;
  const suffix = randomUUID().replaceAll('-', '');
  const org = `org_${suffix}`;
  const owner = `owner_${suffix}`;
  const explicit = `explicit_${suffix}`;
  const assigned = `assigned_${suffix}`;
  const outsider = `outsider_${suffix}`;
  let siteId: string;
  let projectId: string;

  type AuditRow = {
    entity_type: string;
    action: string;
    actor_member_id: string | null;
    actor_kind: string;
    project_id: string | null;
    request_id: string | null;
    changed: Record<string, unknown>;
  };

  const as = <T>(memberId: string, run: (tx: Tx) => Promise<T>, requestId = randomUUID()) =>
    withTenantTransaction(harness.db, { organizationId: org, memberId, requestId }, run);

  const insertTask = (tx: Tx, id: string, assignee: string | null = null) =>
    tx.execute(sql`
      insert into task (id, organization_id, created_by_member_id, project_id, title, position, assignee_member_id)
      values (${id}, ${org}, ${owner}, ${projectId}, 'Excavar', 'a0', ${assignee})
    `);

  const auditOf = (memberId: string, entityId: string) =>
    as(memberId, (tx) =>
      tx.execute<AuditRow>(sql`
        select entity_type, action, actor_member_id, actor_kind, project_id, request_id, changed
          from audit_log where entity_id = ${entityId} order by id
      `),
    ).then((result) => result.rows);

  beforeAll(async () => {
    harness = await startPostgresHarness();
    await insertAuthOrganization(harness.ownerDb, { id: org });
    for (const [memberId, role] of [
      [owner, 'owner'],
      [explicit, 'operator'],
      [assigned, 'operator'],
      [outsider, 'operator'],
    ] as const) {
      await insertAuthMember(harness.ownerDb, { organizationId: org, memberId, role });
    }
    siteId = randomUUID();
    projectId = randomUUID();
    await as(owner, async (tx) => {
      await tx.execute(sql`
        insert into site (id, organization_id, name, timezone)
        values (${siteId}, ${org}, 'Sitio', 'America/Argentina/Buenos_Aires')
      `);
      // Reservado: solo ve el proyecto quien es miembro explícito (o privilegiado).
      await tx.execute(sql`
        insert into project (id, organization_id, site_id, created_by_member_id, code, name, visibility)
        values (${projectId}, ${org}, ${siteId}, ${owner}, 'PRY-AUD', 'Reservado', 'reserved')
      `);
      await tx.execute(sql`
        insert into project_member (id, organization_id, created_by_member_id, project_id, member_id)
        values (${randomUUID()}, ${org}, ${owner}, ${projectId}, ${explicit})
      `);
    });
  });

  afterAll(async () => {
    await harness.stop();
  });

  it('el trigger task_audit está instalado: AFTER, por fila, para INSERT, UPDATE y DELETE', async () => {
    const result = await harness.superuserPool.query<{
      tgname: string;
      timing: string;
      events: string[];
      per_row: boolean;
      function_name: string;
    }>(`
      select t.tgname,
             case when (t.tgtype & 2) = 2 then 'BEFORE' else 'AFTER' end as timing,
             array_remove(array[
               case when (t.tgtype & 4) = 4 then 'INSERT' end,
               case when (t.tgtype & 8) = 8 then 'DELETE' end,
               case when (t.tgtype & 16) = 16 then 'UPDATE' end
             ], null) as events,
             (t.tgtype & 1) = 1 as per_row,
             p.proname as function_name
        from pg_trigger t
        join pg_proc p on p.oid = t.tgfoid
       where t.tgrelid = 'public.task'::regclass and not t.tgisinternal and t.tgname = 'task_audit'
    `);

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
      timing: 'AFTER',
      per_row: true,
      function_name: 'audit_trigger',
    });
    expect([...(result.rows[0]?.events ?? [])].sort()).toEqual(['DELETE', 'INSERT', 'UPDATE']);
  });

  it('crear una tarea deja una entrada con el actor, el proyecto y el request', async () => {
    const id = randomUUID();
    await as(owner, (tx) => insertTask(tx, id), 'req-alta');

    const entries = await auditOf(owner, id);

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      entity_type: 'task',
      action: 'insert',
      actor_member_id: owner,
      actor_kind: 'member',
      project_id: projectId,
      request_id: 'req-alta',
    });
    expect(entries[0]?.changed).toMatchObject({ title: 'Excavar', status: 'pending' });
  });

  it('un cambio de estado deja su fila en audit_log con el valor anterior y el nuevo', async () => {
    const id = randomUUID();
    await as(owner, (tx) => insertTask(tx, id));

    await as(
      explicit,
      (tx) => tx.execute(sql`update task set status = 'in_progress' where id = ${id}`),
      'req-estado',
    );

    const entries = await auditOf(owner, id);
    const change = entries.find((entry) => entry.action === 'update');
    expect(change).toMatchObject({
      entity_type: 'task',
      actor_member_id: explicit,
      actor_kind: 'member',
      project_id: projectId,
      request_id: 'req-estado',
      changed: { status: ['pending', 'in_progress'] },
    });
  });

  it('un UPDATE que no cambia ningún dato (solo version/updated_at) no genera entrada', async () => {
    const id = randomUUID();
    await as(owner, (tx) => insertTask(tx, id));
    await as(owner, (tx) => tx.execute(sql`update task set title = title where id = ${id}`));

    expect((await auditOf(owner, id)).map((entry) => entry.action)).toEqual(['insert']);
  });

  it('borrar la tarea (deleted_at) queda como un cambio de deleted_at', async () => {
    const id = randomUUID();
    await as(owner, (tx) => insertTask(tx, id));
    await as(owner, (tx) => tx.execute(sql`update task set deleted_at = now() where id = ${id}`));

    const entries = await auditOf(owner, id);
    const change = entries.find((entry) => entry.action === 'update');
    expect(Object.keys(change?.changed ?? {})).toEqual(['deleted_at']);
  });

  it('un cambio del contexto de sistema (worker, script) queda con actor nulo y actor_kind system', async () => {
    const id = randomUUID();
    await withSystemTransaction(
      harness.workerDb,
      { organizationId: org, job: 'prueba-audit', requestId: 'r1' },
      (tx) => insertTask(tx, id),
    );

    const rows = await harness.superuserPool.query<{
      actor_kind: string;
      actor_member_id: string | null;
      request_id: string | null;
    }>('select actor_kind, actor_member_id, request_id from audit_log where entity_id = $1', [id]);
    expect(rows.rows).toEqual([
      { actor_kind: 'system', actor_member_id: null, request_id: 'system:prueba-audit:r1' },
    ]);
  });

  describe('quién lee la entrada (ADR-017 §3)', () => {
    it('la ven el privilegiado y el miembro explícito del proyecto', async () => {
      const id = randomUUID();
      await as(owner, (tx) => insertTask(tx, id));

      expect(await auditOf(owner, id)).toHaveLength(1);
      expect(await auditOf(explicit, id)).toHaveLength(1);
    });

    it('no la ve quien solo tiene la tarea asignada, ni quien no ve el proyecto', async () => {
      const id = randomUUID();
      await as(owner, (tx) => insertTask(tx, id, assigned));
      // El asignado ve su tarea ("solo asignado"), pero el audit de proyecto exige acceso completo.
      const ownTask = await as(assigned, (tx) =>
        tx.execute(sql`select id from task where id = ${id}`),
      );
      expect(ownTask.rows).toHaveLength(1);

      expect(await auditOf(assigned, id)).toEqual([]);
      expect(await auditOf(outsider, id)).toEqual([]);
    });
  });

  it('otra organización no ve las entradas', async () => {
    const otherOrg = `other_${suffix}`;
    const otherMember = `other_member_${suffix}`;
    await insertAuthOrganization(harness.ownerDb, { id: otherOrg });
    await insertAuthMember(harness.ownerDb, {
      organizationId: otherOrg,
      memberId: otherMember,
      role: 'owner',
    });
    const id = randomUUID();
    await as(owner, (tx) => insertTask(tx, id));

    const seen = await withTenantTransaction(
      harness.db,
      { organizationId: otherOrg, memberId: otherMember, requestId: randomUUID() },
      (tx) => tx.execute(sql`select id from audit_log where entity_id = ${id}`),
    );

    expect(seen.rows).toEqual([]);
  });
});
